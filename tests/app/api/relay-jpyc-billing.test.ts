// relay route (handleFree) の **a1 配線** を実 POST で検証する。既存 relay-jpyc.test.ts は relayer
// 未設定 (503) で handleFree に到達しないため、ゲート/メーターの配線が未実行 (LARP F1)。本テストは
// RELAYER_PRIVATE_KEY を設定 (self-host) し relay コア (relayJpycAuthorization) のみモック、
// feeGate / billingMeter / feeCurrent / usageFee は **実コード + in-memory KV** で通す。
// 検証対象 = 「handleFree が関所ゲートを正しい位置で呼び 402 を返す / 成功時に merchant=auth.to で
// メーター記録する / 利用料支払い (to=FEE_RECEIVER) を除外する」配線そのもの。
// Amoy (testnet) を使い mainnet hardening (KV/gas-ceiling 必須) を回避する。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1. relayer self-host を有効化 (import 前に env を立てる)。
vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = '0x' + '1'.repeat(64);
});

// 2. in-memory KV (最下層境界のみ)。
const { kvMod, store } = vi.hoisted(() => {
  const vals = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const counters = new Map<string, number>();
  const kvMod = {
    isKvConfigured: () => true,
    kvGet: async (k: string) => ({ ok: true as const, value: vals.has(k) ? vals.get(k)! : null }),
    kvSet: async (k: string, v: string, opts: { nx?: boolean } = {}) => {
      if (opts.nx && vals.has(k)) return { ok: true as const, value: null };
      vals.set(k, v);
      return { ok: true as const, value: 'OK' as const };
    },
    kvDel: async (k: string) => ({ ok: true as const, value: vals.delete(k) ? 1 : 0 }),
    kvGetDel: async (k: string) => {
      const v = vals.has(k) ? vals.get(k)! : null;
      vals.delete(k);
      return { ok: true as const, value: v };
    },
    kvIncr: async (k: string) => {
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return { ok: true as const, value: n };
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
  return { kvMod, store: { vals, lists, counters } };
});
vi.mock('@/lib/kv', () => kvMod);

// 3. relay コア (= 別途 jpycRelay.test.ts で検証済) のみモック。これにより handleFree の
//    ゲート/メーター配線が実行される。result は controllable。
const relayFn = vi.hoisted(() =>
  vi.fn(async (): Promise<{ kind: string; txHash?: string }> => ({
    kind: 'success',
    txHash: '0xfeed',
  })),
);
vi.mock('@/lib/relay/jpycRelay', () => ({ relayJpycAuthorization: relayFn }));

const FEE_RECEIVER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      // relay POST は status route と同じく flag + provider の双方を要求する (A5)。
      enableJpycEip3009: true,
      enableBilling: true,
      enableUsageFee: true,
      feeReceiverConfigured: true,
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/relay/jpyc/route';
import { recordRelayedVolume } from '@/lib/billingMeter';

const AMOY = 80002;
const MERCHANT = '0x0000000000000000000000000000000000000abc';
const CUSTOMER = '0x0000000000000000000000000000000000000def';
const JPYC = 10n ** 18n;
// 固定時刻: 2026-07-15 (day 15 > grace 7)。previousPeriod = 2026-06。
const NOW = Date.UTC(2026, 6, 15);
const JUN = Date.UTC(2026, 5, 15); // 前月 (請求対象) のタイムスタンプ

function payload(over: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: AMOY,
      from: CUSTOMER,
      to: MERCHANT,
      value: (1_000n * JPYC).toString(),
      validAfter: '0',
      validBefore: String(Math.floor(NOW / 1000) + 600),
      nonce: '0x' + 'a'.repeat(64),
      signature: '0x' + 'b'.repeat(130),
      ...over,
    }),
  });
}

beforeEach(() => {
  store.vals.clear();
  store.lists.clear();
  store.counters.clear();
  relayFn.mockClear();
  relayFn.mockResolvedValue({ kind: 'success', txHash: '0xfeed' });
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  process.env.ALPHA_ENTITLEMENT_BYPASS = '0';
  process.env.OPENPAY_USAGE_FEE_START_PERIOD = '2020-01'; // 全期間 1%
  delete process.env.OPENPAY_USAGE_FEE_BPS;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ALPHA_ENTITLEMENT_BYPASS;
  delete process.env.OPENPAY_USAGE_FEE_START_PERIOD;
});

describe('relay route handleFree — a1 配線 (実コード)', () => {
  it('未払い店主 (前月請求あり・猶予超過) → 402 fee_required・relay を呼ばない', async () => {
    // 前月に中継実績を記録 (実 recordRelayedVolume → in-memory KV)。
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 5_000n * JPYC, nowMs: JUN });
    const res = await POST(payload());
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'fee_required' });
    expect(relayFn).not.toHaveBeenCalled(); // ゲートで止まり relay に到達しない
  });

  it('前月請求なし → ゲート通過 → relay 成功時に店主別出来高をメーター記録 (merchant=auth.to)', async () => {
    const res = await POST(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, txHash: '0xfeed' });
    expect(relayFn).toHaveBeenCalledTimes(1);
    // 当月 (2026-07) の MERCHANT メーターに value が記録される。
    const key = `meter:2026-07:${MERCHANT.toLowerCase()}`;
    const events = store.lists.get(key) ?? [];
    expect(events).toHaveLength(1);
    const ev = JSON.parse(events[0]);
    expect(ev.v).toBe((1_000n * JPYC).toString());
    expect(ev.c).toBe(AMOY);
  });

  it('利用料支払い (to=FEE_RECEIVER) → ゲート通過 + メーターに計上しない (売上でない)', async () => {
    // 仮に過去に請求があっても利用料支払いは通す。
    await recordRelayedVolume({ chainId: AMOY, merchant: MERCHANT, value: 5_000n * JPYC, nowMs: JUN });
    const res = await POST(payload({ from: MERCHANT, to: FEE_RECEIVER }));
    expect(res.status).toBe(200); // 遮断されない
    expect(relayFn).toHaveBeenCalledTimes(1);
    // FEE_RECEIVER 宛は売上メーターに計上しない。
    const key = `meter:2026-07:${FEE_RECEIVER.toLowerCase()}`;
    expect(store.lists.get(key) ?? []).toHaveLength(0);
  });

  it('relay が reverted → メーター記録しない (成功時のみ計上)', async () => {
    relayFn.mockResolvedValue({ kind: 'reverted', txHash: '0xrev' });
    const res = await POST(payload());
    expect(res.status).toBe(200); // reverted は ok:false, reverted:true で 200
    const key = `meter:2026-07:${MERCHANT.toLowerCase()}`;
    expect(store.lists.get(key) ?? []).toHaveLength(0);
  });
});
