import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS,
  ORDER_NOTIFY_LOG_BODY_WAIT_MS,
  ORDER_NOTIFY_RATE_LIMIT,
  ORDER_NOTIFY_RATE_WINDOW_MS,
  ORDER_NOTIFY_SERVER_ERRORS,
  orderNotifyAutoRetryBaseDelayMs,
  orderNotifyQuotaWaitMs,
  orderNotifyServerErrorForLog,
} from '@/lib/order/notifyRetry';
import { parseSource, readSource, runtimeSpecifiers } from '../_helpers/runtimeImports';

// lib/order/notifyRetry.ts (r10-notify): /checkout の完了の受注通知 (経路 A) を自動で送り直すときの、待ち時間と回数。
// ここは計算だけの表。画面でどう効くか (送る時刻・案内・ボタン) は
// tests/components/CheckoutForm.orderNotify.characterization.test.tsx の COMPLETION_ROWS と「D の後に A が続く順番」。

// いま (sendAt) 送る 1 回を入れて、その時点から直近 61 秒の送信が何回になるか (server の枠は 60 秒に 5 回)。
const sendsInWindowAt = (sentAt: number[], sendAt: number) =>
  [...sentAt, sendAt].filter((at) => at <= sendAt && at > sendAt - ORDER_NOTIFY_RATE_WINDOW_MS).length;

describe('orderNotifyAutoRetryBaseDelayMs: 自動の送り直しの待ち時間と回数の上限', () => {
  it.each([
    { name: '1 回目 (503)', retryIndex: 0, status: 503, want: 2_000 },
    { name: '2 回目 (503)', retryIndex: 1, status: 503, want: 15_000 },
    { name: '1 回目 (422 tx_not_found)', retryIndex: 0, status: 422, want: 2_000 },
    { name: '2 回目 (409 processing)', retryIndex: 1, status: 409, want: 15_000 },
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

  it('回数の上限は 2 回・server の窓 (60 秒) より 1 秒長く待つ・枠は 5 回・記録の欄のために本文を待つのは 3 秒まで', () => {
    expect(ORDER_NOTIFY_AUTO_RETRY_DELAYS_MS).toEqual([2_000, 15_000]);
    expect(ORDER_NOTIFY_RATE_WINDOW_MS).toBe(61_000);
    expect(ORDER_NOTIFY_RATE_LIMIT).toBe(5);
    expect(ORDER_NOTIFY_LOG_BODY_WAIT_MS).toBe(3_000);
  });
});

describe('orderNotifyQuotaWaitMs: 枠の確かめ (いま送ると直近 61 秒が 5 回を超えるなら、あと何 ms)', () => {
  type Row = { name: string; sentAt: number[]; now: number; want: number };
  const ROWS: Row[] = [
    { name: '送っていない → 待たない', sentAt: [], now: 0, want: 0 },
    { name: '送ったのが 1 回 → 待たない', sentAt: [0], now: 0, want: 0 },
    { name: '4 回 → まだ枠がある', sentAt: [0, 250, 1_250, 5_250], now: 5_250, want: 0 },
    // いま送ると 6 回になるので、いちばん古い 1 回 (0 秒) が窓を出る 61 秒まで待つ。
    { name: '直近に 5 回 → 新しい方から 5 番目 (0 秒) の 61 秒後まで', sentAt: [0, 250, 1_250, 5_250, 20_250], now: 20_250, want: 40_750 },
    { name: '5 回・ちょうど窓を出た時刻', sentAt: [0, 1, 2, 3, 4], now: 61_000, want: 0 },
    { name: '5 回・窓を出る 1 ms 前', sentAt: [0, 1, 2, 3, 4], now: 60_999, want: 1 },
    { name: '順番は問わない (新しい順でも同じ)', sentAt: [20_250, 5_250, 1_250, 250, 0], now: 20_250, want: 40_750 },
    { name: '古い送信 (61 秒より前) は数えない', sentAt: [0, 250, 1_250, 5_250, 20_250], now: 100_000, want: 0 },
    { name: '同じ時刻に 5 回', sentAt: [0, 0, 0, 0, 0], now: 1_000, want: 60_000 },
    // 計画レビューの筋 1: 部分の通知が 0〜20 秒に 5 回送った後、30 秒に完了の通知 (6 回目 = server が 429 で断る)。
    // 429 の後の 61 秒 (基本の待ち時間) を待った時点では、枠はもう空いている。
    { name: 'レビューの筋 1: D が 0〜20 秒に 5 回 → 30 秒に A が 429 → 61 秒待った後', sentAt: [0, 250, 1_250, 5_250, 20_250, 30_000], now: 91_000, want: 0 },
    // server が数えずに 503 を返した場合は 2 秒後に見る: 0.25 秒の送信の 61 秒後 (61.25 秒) まで、あと 29.25 秒。
    { name: 'レビューの筋 1 (503 だった場合): 2 秒待った後も、まだ枠が無い', sentAt: [0, 250, 1_250, 5_250, 20_250, 30_000], now: 32_000, want: 29_250 },
    // 筋 2: 部分の通知が届いた後、完了の通知が続けて失敗 (回数が少ないので、枠では待たない)。
    { name: 'レビューの筋 2: D が届いた後に A が 503 → 2 秒後', sentAt: [0, 1_000], now: 3_000, want: 0 },
    { name: 'レビューの筋 2: 続けて 503 → 15 秒後', sentAt: [0, 1_000, 3_000], now: 18_000, want: 0 },
    // Codex の順: 完了の通知が 0.2 秒に失敗した時点では 3 回。2 秒待つ間に部分の通知が 3 回送ると、送る直前には 6 回。
    { name: '待つ前に見ると 3 回 (待たない)', sentAt: [0, 100, 200], now: 200, want: 0 },
    { name: '同じ支払いを、送る直前に見直すと 6 回 → 0.1 秒の送信の 61 秒後まで', sentAt: [0, 100, 200, 250, 1_250, 5_250], now: 5_250, want: 55_850 },
  ];

  it.each(ROWS)('$name → $want ms', ({ sentAt, now, want }) => {
    expect(orderNotifyQuotaWaitMs(sentAt, now)).toBe(want);
  });

  it.each(ROWS)('$name: 待った後に送れば、直近 61 秒の送信は 5 回以下。待つ行は、1 ms 早いと 6 回になる', ({ sentAt, now }) => {
    const wait = orderNotifyQuotaWaitMs(sentAt, now);
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(sendsInWindowAt(sentAt, now + wait)).toBeLessThanOrEqual(ORDER_NOTIFY_RATE_LIMIT);
    if (wait > 0) {
      expect(sendsInWindowAt(sentAt, now + wait - 1)).toBe(ORDER_NOTIFY_RATE_LIMIT + 1);
    }
  });

  it('渡した配列を並べ替えない', () => {
    const sentAt = [20_250, 0, 5_250, 250, 1_250];
    orderNotifyQuotaWaitMs(sentAt, 20_250);
    expect(sentAt).toEqual([20_250, 0, 5_250, 250, 1_250]);
  });
});

describe('orderNotifyServerErrorForLog: 記録に載せてよいのは、server が決めた error の語だけ', () => {
  it.each([...ORDER_NOTIFY_SERVER_ERRORS])('%s → そのまま', (error) => {
    expect(orderNotifyServerErrorForLog(error)).toBe(error);
  });

  it.each([
    // 形は server の語と同じ (小文字と _) でも、列挙に無ければ載せない。
    { name: '語の形をした、列挙に無い文字列', error: 'my_private_password' },
    { name: '列挙の語の前後に字が付いたもの', error: 'rpc_error_x' },
    { name: '列挙の語の一部', error: 'rpc' },
    { name: '空の文字列', error: '' },
    { name: '大文字', error: 'RPC_ERROR' },
    { name: '前後に空白', error: ' rpc_error' },
    { name: '改行で終わる', error: 'rpc_error\n' },
    { name: '空白を含む文', error: 'upstream connect error' },
    { name: 'URL', error: 'https://example.com/?key=secret' },
    { name: '数値', error: 503 },
    { name: '配列 (中身は列挙の語)', error: ['rpc_error'] },
    { name: 'object', error: { message: 'x' } },
    { name: 'null', error: null },
    { name: 'undefined', error: undefined },
  ])('$name → 載せない (undefined)', ({ error }) => {
    expect(orderNotifyServerErrorForLog(error)).toBeUndefined();
  });
});

// 列挙 (ORDER_NOTIFY_SERVER_ERRORS) が、server が実際に返す語と同じであること。route が語を足したのに列挙が古いままだと、
// その語が記録に載らなくなる。見るのは 2 つの file の source だけ:
//   app/api/order/notify/route.ts … fail(語, status) の 1 つ目の引数。
//   lib/feeVerify.ts            … route が fail(result.reason, …) でそのまま返す、on-chain の検証の理由 (FeeVerifyResult の reason)。
describe('ORDER_NOTIFY_SERVER_ERRORS は、/api/order/notify が返す error の語と同じ', () => {
  const ROUTE = 'app/api/order/notify/route.ts';
  const VERIFY = 'lib/feeVerify.ts';

  // route の fail(…) の 1 つ目の引数: 文字列そのもの・「条件 ? 文字列 : 文字列」・result.reason (検証の理由をそのまま返す) の 3 つの形。
  function routeErrors() {
    const words = new Set<string>();
    const unknownForms: string[] = [];
    let passesVerifyReason = false;
    const tree = parseSource(ROUTE, readSource(ROUTE));
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fail') {
        const [first] = node.arguments;
        const branches = first && ts.isConditionalExpression(first) ? [first.whenTrue, first.whenFalse] : [first];
        for (const branch of branches) {
          if (branch && ts.isStringLiteral(branch)) words.add(branch.text);
          else if (branch?.getText(tree) === 'result.reason') passesVerifyReason = true;
          else unknownForms.push(node.getText(tree));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return { words, unknownForms, passesVerifyReason };
  }

  // lib/feeVerify.ts の `export type FeeVerifyResult` の中の `reason:` の文字列の型。
  function verifyReasons() {
    const reasons = new Set<string>();
    const tree = parseSource(VERIFY, readSource(VERIFY));
    const collect = (node: ts.Node) => {
      if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) reasons.add(node.literal.text);
      ts.forEachChild(node, collect);
    };
    const visit = (node: ts.Node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === 'FeeVerifyResult') {
        const findReason = (inner: ts.Node) => {
          if (ts.isPropertySignature(inner) && inner.name.getText(tree) === 'reason' && inner.type) collect(inner.type);
          ts.forEachChild(inner, findReason);
        };
        findReason(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return reasons;
  }

  it('route の fail(…) の語 + 検証の理由 = 列挙 (過不足なし)', () => {
    const route = routeErrors();
    // 読めない形の fail(…) が増えたら、ここで止める (語を拾い損ねたまま通さない)。
    expect(route.unknownForms).toEqual([]);
    expect(route.passesVerifyReason).toBe(true);
    // 空振りでないこと: route の語と、検証の理由の両方を拾えている。
    expect(route.words.has('rate_limited')).toBe(true);
    expect(route.words.size).toBeGreaterThanOrEqual(20);
    const reasons = verifyReasons();
    expect([...reasons].sort()).toEqual(['amount_too_low', 'no_matching_transfer', 'rpc_error', 'tx_not_found', 'tx_reverted', 'unexpected_transfer']);

    expect([...ORDER_NOTIFY_SERVER_ERRORS]).toEqual([...new Set([...route.words, ...reasons])].sort());
  });

  it('列挙は語の形 (小文字と _) だけで、重複が無い', () => {
    expect(new Set(ORDER_NOTIFY_SERVER_ERRORS).size).toBe(ORDER_NOTIFY_SERVER_ERRORS.length);
    for (const word of ORDER_NOTIFY_SERVER_ERRORS) expect(word).toMatch(/^[a-z_]+$/);
  });
});

describe('lib/order/notifyRetry.ts は何も import しない (純関数だけ)', () => {
  it('bundle に残る import (import・再 export・import()・require()) が 1 つも無い', () => {
    const file = 'lib/order/notifyRetry.ts';
    expect(runtimeSpecifiers(file, readSource(file))).toEqual([]);
  });
});
