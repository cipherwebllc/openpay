import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(),
}));

import {
  getFeeStatus,
  isFeeCurrent,
  grantFeeCurrent,
  markPeriodPaid,
  getUnpaidPeriods,
  PAID_MARKER_TTL_SEC,
} from '@/lib/feeCurrent';
import { kvGet, kvSet } from '@/lib/kv';

const WALLET = '0xAbC0000000000000000000000000000000000009';
const KEY = `fee:current:${WALLET.toLowerCase()}`;
const NOW = Date.UTC(2026, 6, 15, 0, 0, 0); // 2026-07-15
const DAY = 86_400_000;

const mGet = kvGet as unknown as ReturnType<typeof vi.fn>;
const mSet = kvSet as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // 非 bypass (徴収運用) を既定にする。
  process.env.ALPHA_ENTITLEMENT_BYPASS = '0';
  mGet.mockResolvedValue({ ok: true, value: null });
  mSet.mockResolvedValue({ ok: true, value: 'OK' });
});

afterEach(() => {
  delete process.env.ALPHA_ENTITLEMENT_BYPASS;
});

describe('getFeeStatus / isFeeCurrent', () => {
  it('bypass ON (アルファ) は KV を見ず常に current', async () => {
    process.env.ALPHA_ENTITLEMENT_BYPASS = '1';
    const s = await getFeeStatus(WALLET, NOW);
    expect(s).toEqual({ current: true, expiresAt: null, lastPaidPeriod: null, bypass: true });
    expect(kvGet).not.toHaveBeenCalled();
  });

  it('非 bypass・記録なし → current false', async () => {
    mGet.mockResolvedValue({ ok: true, value: null });
    expect(await isFeeCurrent(WALLET, NOW)).toBe(false);
  });

  it('非 bypass・有効期限内 → current true', async () => {
    mGet.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ expiresAt: NOW + 10 * DAY, lastPaidPeriod: '2026-07' }),
    });
    const s = await getFeeStatus(WALLET, NOW);
    expect(s.current).toBe(true);
    expect(s.lastPaidPeriod).toBe('2026-07');
    expect(s.bypass).toBe(false);
  });

  it('非 bypass・期限切れ → current false', async () => {
    mGet.mockResolvedValue({
      ok: true,
      value: JSON.stringify({ expiresAt: NOW - DAY }),
    });
    expect(await isFeeCurrent(WALLET, NOW)).toBe(false);
  });

  it('境界: expiresAt == now は current false (strict >)', async () => {
    mGet.mockResolvedValue({ ok: true, value: JSON.stringify({ expiresAt: NOW }) });
    expect(await isFeeCurrent(WALLET, NOW)).toBe(false);
  });

  it('壊れた値 → current false', async () => {
    mGet.mockResolvedValue({ ok: true, value: 'not-json' });
    expect(await isFeeCurrent(WALLET, NOW)).toBe(false);
  });
});

describe('grantFeeCurrent', () => {
  const EXP = Date.UTC(2026, 7, 8); // period 基準の決定的満了 (= feeCoverageThrough 相当)

  it('新規付与: expiresAt をそのまま設定し JSON+TTL で保存', async () => {
    mGet.mockResolvedValue({ ok: true, value: null });
    const r = await grantFeeCurrent(
      WALLET,
      { period: '2026-07', txHash: '0xabc', expiresAt: EXP },
      NOW,
    );
    expect(r).toEqual({ ok: true, expiresAt: EXP });
    expect(mSet).toHaveBeenCalledTimes(1);
    const [key, payload, opts] = mSet.mock.calls[0];
    expect(key).toBe(KEY);
    const stored = JSON.parse(payload as string);
    expect(stored.expiresAt).toBe(EXP);
    expect(stored.lastPaidPeriod).toBe('2026-07');
    expect(stored.lastTxHash).toBe('0xabc');
    expect((opts as { ttlSec: number }).ttlSec).toBe(Math.ceil((EXP - NOW) / 1000));
  });

  it('既存が長ければ延長は max (短い新規で縮めない)', async () => {
    const farFuture = NOW + 100 * DAY;
    mGet.mockResolvedValue({ ok: true, value: JSON.stringify({ expiresAt: farFuture }) });
    const r = await grantFeeCurrent(WALLET, { expiresAt: NOW + 10 * DAY }, NOW);
    expect(r.expiresAt).toBe(farFuture); // max(既存, 新規)
    expect(JSON.parse(mSet.mock.calls[0][1] as string).expiresAt).toBe(farFuture);
  });

  it('決定的 expiresAt: 既存と同値で再付与しても延長しない (idempotent)', async () => {
    mGet.mockResolvedValue({ ok: true, value: JSON.stringify({ expiresAt: EXP }) });
    const r = await grantFeeCurrent(WALLET, { expiresAt: EXP }, NOW);
    expect(r.expiresAt).toBe(EXP); // max(EXP, EXP) = EXP・延びない
  });

  it('KV書込が応答ロス→読み戻しで意図充足なら ok:true', async () => {
    mSet.mockResolvedValue({ ok: false, reason: 'timeout' });
    mGet
      .mockResolvedValueOnce({ ok: true, value: null }) // マージ用
      .mockResolvedValueOnce({ ok: true, value: JSON.stringify({ expiresAt: EXP }) });
    const r = await grantFeeCurrent(WALLET, { expiresAt: EXP }, NOW);
    expect(r.ok).toBe(true);
  });

  it('KV書込が応答ロス→読み戻しでも未永続化なら ok:false', async () => {
    mSet.mockResolvedValue({ ok: false, reason: 'timeout' });
    mGet
      .mockResolvedValueOnce({ ok: true, value: null }) // マージ用
      .mockResolvedValueOnce({ ok: true, value: null }); // readback: 無し
    const r = await grantFeeCurrent(WALLET, { expiresAt: EXP }, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('markPeriodPaid (期間別 支払い済みマーカー)', () => {
  it('billing:paid:{wallet}:{period} に txHash を lookback 超え TTL で書く', async () => {
    mSet.mockResolvedValue({ ok: true, value: 'OK' });
    const r = await markPeriodPaid(WALLET, '2026-04', '0xfeed');
    expect(r.ok).toBe(true);
    const [key, value, opts] = mSet.mock.calls[0];
    expect(key).toBe(`billing:paid:${WALLET.toLowerCase()}:2026-04`);
    expect(value).toBe('0xfeed');
    // ゲート lookback (12 か月) を余裕で超える 800 日。
    expect((opts as { ttlSec: number }).ttlSec).toBe(PAID_MARKER_TTL_SEC);
    expect(PAID_MARKER_TTL_SEC).toBe(800 * 86_400);
  });

  it('KV 書込失敗 → ok:false (呼出側で清算失敗扱い)', async () => {
    mSet.mockResolvedValue({ ok: false, reason: 'timeout' });
    const r = await markPeriodPaid(WALLET, '2026-04', '0xfeed');
    expect(r.ok).toBe(false);
  });
});

describe('getUnpaidPeriods (マーカー無し=未払い・読み失敗は fail-open)', () => {
  const KEY_OF = (p: string) => `billing:paid:${WALLET.toLowerCase()}:${p}`;

  it('マーカー無し (null) の期間だけ未払いとして返す', async () => {
    mGet.mockImplementation(async (key: string) => {
      if (key === KEY_OF('2026-05')) return { ok: true, value: '0xpaid' }; // 支払い済み
      return { ok: true, value: null }; // 04, 06 はマーカー無し
    });
    const out = await getUnpaidPeriods(WALLET, ['2026-06', '2026-05', '2026-04']);
    expect(out.sort()).toEqual(['2026-04', '2026-06']);
  });

  it('読み取り失敗の期間は支払い済み扱い (fail-open・未払いに含めない)', async () => {
    mGet.mockImplementation(async (key: string) => {
      if (key === KEY_OF('2026-06')) return { ok: false, reason: 'timeout' }; // 読めない
      return { ok: true, value: null }; // 05 はマーカー無し = 未払い
    });
    const out = await getUnpaidPeriods(WALLET, ['2026-06', '2026-05']);
    expect(out).toEqual(['2026-05']); // 06 は fail-open で除外
  });

  it('空配列 → 空配列', async () => {
    const out = await getUnpaidPeriods(WALLET, []);
    expect(out).toEqual([]);
  });
});
