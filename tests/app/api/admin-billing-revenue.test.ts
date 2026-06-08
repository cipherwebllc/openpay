// admin 収益 route を **実コード + in-memory KV** で検証。SIWE はモック、isAdminWallet は実コード
// (ADMIN_WALLETS env)。403(非admin)/200(JSON: 合計+照合)/CSV(?format=freee) を通す。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { kvMod, store } = vi.hoisted(() => {
  const vals = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const kvMod = {
    isKvConfigured: () => true,
    kvGet: async (k: string) => ({ ok: true as const, value: vals.has(k) ? vals.get(k)! : null }),
    kvSet: async (k: string, v: string, opts: { nx?: boolean } = {}) => {
      if (opts.nx && vals.has(k)) return { ok: true as const, value: null };
      vals.set(k, v);
      return { ok: true as const, value: 'OK' as const };
    },
    kvLpush: async (k: string, v: string) => {
      const l = lists.get(k) ?? [];
      l.unshift(v);
      lists.set(k, l);
      return { ok: true as const, value: l.length };
    },
    kvLrange: async (k: string, start: number, stop: number) => {
      const l = lists.get(k) ?? [];
      return { ok: true as const, value: l.slice(start, stop === -1 ? l.length : stop + 1) };
    },
    kvLlen: async (k: string) => ({ ok: true as const, value: (lists.get(k) ?? []).length }),
    kvLtrim: async (k: string, start: number, stop: number) => {
      lists.set(k, (lists.get(k) ?? []).slice(start, stop + 1));
      return { ok: true as const, value: 'OK' as const };
    },
    kvExpire: async () => ({ ok: true as const, value: 1 }),
  };
  return { kvMod, store: { vals, lists } };
});
vi.mock('@/lib/kv', () => kvMod);

const session = vi.hoisted(() => ({ address: '0x000000000000000000000000000000000000ad11' }));
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () => ({ ok: true as const, address: session.address }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from '@/app/api/admin/billing/revenue/route';
import { recordRelayedVolume } from '@/lib/billingMeter';
import { recordFeeRevenue } from '@/lib/feeRevenue';

const JPYC = 10n ** 18n;
const AMOY = 80002;
const ADMIN = '0x000000000000000000000000000000000000ad11';
const MERCHANT = '0x000000000000000000000000000000000000000a' as `0x${string}`;
const req = (qs = '') => new Request(`http://localhost/api/admin/billing/revenue${qs}`);

// settle が課金する previousPeriod に合わせ、その期間で出来高+入金を仕込む。
function periods(nowMs: number) {
  const d = new Date(nowMs);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  const p = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const tsInPrev = Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), 15);
  return { prevPeriod: p, tsInPrev };
}

beforeEach(() => {
  store.vals.clear();
  store.lists.clear();
  session.address = ADMIN;
  process.env.ADMIN_WALLETS = ADMIN;
  process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2020-01';
  delete process.env.OPENPAY_USAGE_FEE_BPS;
});
afterEach(() => {
  delete process.env.ADMIN_WALLETS;
  delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
});

describe('admin billing revenue route', () => {
  it('非 admin → 403', async () => {
    process.env.ADMIN_WALLETS = '0x0000000000000000000000000000000000009999';
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('admin → 200 JSON: 合計 + 照合 (請求 vs 入金)', async () => {
    const now = Date.now();
    const { prevPeriod, tsInPrev } = periods(now);
    // 前月に中継 (索引+メーター) → 請求対象。入金も記録。
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 10_000n * JPYC, nowMs: tsInPrev });
    await recordFeeRevenue({ merchant: MERCHANT, period: prevPeriod, feeWei: 100n * JPYC, chainId: AMOY, txHash: '0xpaid', paidAtMs: now });

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.totalWei).toBe((100n * JPYC).toString());
    expect(body.count).toBe(1);
    expect(body.reconciliation.period).toBe(prevPeriod);
    const row = body.reconciliation.rows.find(
      (r: { merchant: string }) => r.merchant === MERCHANT.toLowerCase(),
    );
    expect(row).toMatchObject({ billedFeeWei: (100n * JPYC).toString(), paid: true, txHash: '0xpaid' });
    expect(body.payments).toHaveLength(1);
  });

  it('?format=freee → CSV (text/csv・ヘッダ)', async () => {
    await recordFeeRevenue({ merchant: MERCHANT, period: '2026-06', feeWei: 100n * JPYC, chainId: AMOY, txHash: '0xz', paidAtMs: Date.now() });
    const res = await GET(req('?format=freee'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('入金日(UTC)');
    expect(text).toContain('100');
  });
});
