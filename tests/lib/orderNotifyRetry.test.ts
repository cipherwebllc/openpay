import { describe, expect, it } from 'vitest';
import {
  ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS,
  ORDER_NOTIFY_RATE_LIMIT,
  ORDER_NOTIFY_RATE_WINDOW_MS,
  orderNotifyAutoRetryBaseDelayMs,
  orderNotifyRetryWaitMs,
  orderNotifyServerErrorForLog,
} from '@/lib/order/notifyRetry';
import { readSource, runtimeSpecifiers } from '../_helpers/runtimeImports';

// lib/order/notifyRetry.ts (r10-notify): /checkout の完了の受注通知 (経路 A) を自動で送り直すときの、待ち時間と回数。
// ここは計算だけの表。画面でどう効くか (送る時刻・案内・ボタン) は
// tests/components/CheckoutForm.orderNotify.characterization.test.tsx の COMPLETION_ROWS と「D の後に A が続く順番」。

// 送った後、次に送る 1 回を入れて、その時点から直近 61 秒の送信が何回になるか (server の枠は 60 秒に 5 回)。
const sendsInWindowAt = (sentAt: number[], sendAt: number) =>
  [...sentAt, sendAt].filter((at) => at <= sendAt && at > sendAt - ORDER_NOTIFY_RATE_WINDOW_MS).length;

describe('orderNotifyAutoRetryBaseDelayMs: 自動の送り直しの待ち時間と回数の上限', () => {
  it.each([
    { name: '1 回目 (503)', retryIndex: 0, status: 503, want: 2_000 },
    { name: '2 回目 (503)', retryIndex: 1, status: 503, want: 15_000 },
    { name: '1 回目 (422 tx_not_found)', retryIndex: 0, status: 422, want: 2_000 },
    { name: '1 回目 (2xx で届いた形でない)', retryIndex: 0, status: 200, want: 2_000 },
    { name: '1 回目 (通信の失敗 = status なし)', retryIndex: 0, status: null, want: 2_000 },
    { name: '2 回目 (通信の失敗)', retryIndex: 1, status: null, want: 15_000 },
    { name: '1 回目・直前が 429 → 窓が空くまで', retryIndex: 0, status: 429, want: 61_000 },
    { name: '2 回目・直前が 429 → 窓が空くまで', retryIndex: 1, status: 429, want: 61_000 },
    { name: '3 回目は無い (503)', retryIndex: 2, status: 503, want: null },
    { name: '3 回目は無い (429 でも)', retryIndex: 2, status: 429, want: null },
    { name: '3 回目は無い (通信の失敗)', retryIndex: 2, status: null, want: null },
    { name: '4 回目も無い', retryIndex: 3, status: 503, want: null },
  ])('$name → $want', ({ retryIndex, status, want }) => {
    expect(orderNotifyAutoRetryBaseDelayMs(retryIndex, status)).toBe(want);
  });

  it('回数の上限は 2 回・server の窓 (60 秒) より 1 秒長く待つ・枠は 5 回', () => {
    expect(ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS).toEqual([2_000, 15_000]);
    expect(ORDER_NOTIFY_RATE_WINDOW_MS).toBe(61_000);
    expect(ORDER_NOTIFY_RATE_LIMIT).toBe(5);
  });
});

describe('orderNotifyRetryWaitMs: 枠の確かめ (直近 61 秒に 5 回まで)', () => {
  type Row = { name: string; sentAt: number[]; now: number; base: number; want: number };
  const ROWS: Row[] = [
    { name: '送ったのが 1 回 → 基本の待ち時間のまま', sentAt: [0], now: 0, base: 2_000, want: 2_000 },
    { name: '4 回 → まだ枠がある', sentAt: [0, 250, 1_250, 5_250], now: 5_250, base: 2_000, want: 2_000 },
    // 待った後の 1 回を入れると 6 回になるので、いちばん古い 1 回 (0 秒) が窓を出る 61 秒まで待つ。
    { name: '直近に 5 回 → 新しい方から 5 番目 (0 秒) の 61 秒後まで', sentAt: [0, 250, 1_250, 5_250, 20_250], now: 20_250, base: 2_000, want: 40_750 },
    { name: '5 回でも、基本の待ち時間の間に窓を出るなら、基本の待ち時間のまま', sentAt: [0, 10_000, 20_000, 30_000, 59_500], now: 59_500, base: 2_000, want: 2_000 },
    { name: '5 回・ちょうど 61 秒後に空く', sentAt: [0, 1, 2, 3, 4], now: 59_000, base: 2_000, want: 2_000 },
    { name: '5 回・基本の待ち時間より 1 ms 長く要る', sentAt: [1, 2, 3, 4, 5], now: 59_000, base: 2_000, want: 2_001 },
    { name: '順番は問わない (新しい順でも同じ)', sentAt: [20_250, 5_250, 1_250, 250, 0], now: 20_250, base: 2_000, want: 40_750 },
    { name: '古い送信 (61 秒より前) は数えない', sentAt: [0, 250, 1_250, 5_250, 20_250], now: 100_000, base: 2_000, want: 2_000 },
    { name: '基本の待ち時間 0 でも、枠が無ければ待つ', sentAt: [0, 0, 0, 0, 0], now: 1_000, base: 0, want: 60_000 },
    // 設計の計画レビューの筋 1: 部分の通知が 0〜20 秒に 5 回送った後、30 秒に完了の通知 (6 回目 = server が 429 で断る)。
    {
      name: 'レビューの筋 1: D が 0〜20 秒に 5 回 → 30 秒に A が 429 → 61 秒待てば枠は空いている',
      sentAt: [0, 250, 1_250, 5_250, 20_250, 30_000],
      now: 30_000,
      base: 61_000,
      want: 61_000,
    },
    {
      name: 'レビューの筋 1 (server が数えず 503 を返した場合): 2 秒ではなく、0.25 秒の送信の 61 秒後まで',
      sentAt: [0, 250, 1_250, 5_250, 20_250, 30_000],
      now: 30_000,
      base: 2_000,
      want: 31_250,
    },
    // 筋 2: 部分の通知が届いた後、完了の通知が続けて失敗 (回数が少ないので、枠は待ち時間を延ばさない)。
    { name: 'レビューの筋 2: D が届いた後に A が 503 (1 回目の送り直し)', sentAt: [0, 1_000], now: 1_000, base: 2_000, want: 2_000 },
    { name: 'レビューの筋 2: 続けて 503 (2 回目の送り直し)', sentAt: [0, 1_000, 3_000], now: 3_000, base: 15_000, want: 15_000 },
    // 部分の通知が 2 回 (利用料の送金の hash つきも) + 完了の通知が 409 の表で 3 回 → 5 回。
    { name: 'D 2 回 + A の 409 の表 3 回の後の 503', sentAt: [0, 4_000, 6_000, 6_250, 7_250], now: 7_250, base: 2_000, want: 53_750 },
  ];

  it.each(ROWS)('$name → $want ms', ({ sentAt, now, base, want }) => {
    expect(orderNotifyRetryWaitMs(sentAt, now, base)).toBe(want);
  });

  it.each(ROWS)('$name: 待った後に送っても、直近 61 秒の送信は 5 回以下。1 ms 早いと (枠で延ばした行は) 6 回になる', ({ sentAt, now, base }) => {
    const wait = orderNotifyRetryWaitMs(sentAt, now, base);
    expect(wait).toBeGreaterThanOrEqual(base);
    expect(sendsInWindowAt(sentAt, now + wait)).toBeLessThanOrEqual(ORDER_NOTIFY_RATE_LIMIT);
    if (wait > base) {
      expect(sendsInWindowAt(sentAt, now + wait - 1)).toBe(ORDER_NOTIFY_RATE_LIMIT + 1);
    }
  });

  it('渡した配列を並べ替えない', () => {
    const sentAt = [20_250, 0, 5_250, 250, 1_250];
    orderNotifyRetryWaitMs(sentAt, 20_250, 2_000);
    expect(sentAt).toEqual([20_250, 0, 5_250, 250, 1_250]);
  });
});

describe('orderNotifyServerErrorForLog: 記録に載せてよい error の語', () => {
  it.each(['rate_limited', 'rpc_error', 'tx_not_found', 'kv_error', 'processing', 'a', 'a'.repeat(40)])('%s → そのまま', (error) => {
    expect(orderNotifyServerErrorForLog(error)).toBe(error);
  });

  it.each([
    { name: '空の文字列', error: '' },
    { name: '41 字', error: 'a'.repeat(41) },
    { name: '大文字', error: 'RPC_ERROR' },
    { name: '空白を含む文', error: 'upstream connect error' },
    { name: '数字', error: 'error_503' },
    { name: '改行で終わる', error: 'rpc_error\n' },
    { name: 'URL', error: 'https://example.com/?key=secret' },
    { name: '数値', error: 503 },
    { name: 'object', error: { message: 'x' } },
    { name: 'null', error: null },
    { name: 'undefined', error: undefined },
  ])('$name → 載せない (undefined)', ({ error }) => {
    expect(orderNotifyServerErrorForLog(error)).toBeUndefined();
  });
});

describe('lib/order/notifyRetry.ts は何も import しない (純関数だけ)', () => {
  it('bundle に残る import (import・再 export・import()・require()) が 1 つも無い', () => {
    const file = 'lib/order/notifyRetry.ts';
    expect(runtimeSpecifiers(file, readSource(file))).toEqual([]);
  });
});
