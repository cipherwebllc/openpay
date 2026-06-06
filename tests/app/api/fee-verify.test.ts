import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// 制御用ホルダ (各 test で差し替え)。
const hold = vi.hoisted(() => ({
  enableBilling: true,
  feeReceiverConfigured: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  verify: { ok: true, value: 0n } as
    | { ok: true; value: bigint }
    | { ok: false; reason: string },
  verifyThrows: false, // verifyJpycFeeOnChain が想定外 throw する経路 (LARP-2)
  // kvSet(nx) の戻り: 'OK' = ロック取得 / null = 既に存在 (処理中 or 確定済)。
  kvSetValue: 'OK' as 'OK' | null,
  kvSetOk: true,
  // nx 失敗時に route が読む既存 claim 値。'pending'=処理中(409) / 'r:{...}'=確定(replay)。
  kvGetValue: 'pending' as string | null,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      get enableBilling() {
        return hold.enableBilling;
      },
      get feeReceiverConfigured() {
        return hold.feeReceiverConfigured;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.session.ok
      ? hold.session
      : {
          ok: false,
          response: NextResponse.json(
            { ok: false, error: 'unauthenticated' },
            { status: 401 },
          ),
        },
}));
vi.mock('@/lib/feeVerify', () => ({
  verifyJpycFeeOnChain: vi.fn(async () => {
    if (hold.verifyThrows) throw new Error('rpc down');
    return hold.verify;
  }),
}));
const grantSpy = vi.hoisted(() => vi.fn());
const hold2 = vi.hoisted(() => ({ grantOk: true }));
vi.mock('@/lib/entitlement', () => ({
  ENTITLEMENT_DEFAULT_DAYS: 30,
  grantEntitlement: (...args: unknown[]) => {
    grantSpy(...args);
    return Promise.resolve({ ok: hold2.grantOk, tier: args[1], expiresAt: 999_000 });
  },
}));
const kvSetSpy = vi.hoisted(() => vi.fn());
const kvDelSpy = vi.hoisted(() => vi.fn());
const kvGetSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  kvSet: (...args: unknown[]) => {
    kvSetSpy(...args);
    return Promise.resolve(
      hold.kvSetOk
        ? { ok: true, value: hold.kvSetValue }
        : { ok: false, reason: 'unconfigured' },
    );
  },
  kvGet: (...args: unknown[]) => {
    kvGetSpy(...args);
    return Promise.resolve({ ok: true, value: hold.kvGetValue });
  },
  kvDel: (...args: unknown[]) => {
    kvDelSpy(...args);
    return Promise.resolve({ ok: true, value: 1 });
  },
}));

import { POST } from '@/app/api/fee/verify/route';

const TXHASH = `0x${'1'.repeat(64)}`;
const AMOY = 80002; // testnet env の JPYC 対応 chain

function req(body: unknown): Request {
  return new Request('http://localhost/api/fee/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hold.enableBilling = true;
  hold.feeReceiverConfigured = true;
  hold.session = { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' };
  hold.verify = { ok: true, value: 4980n * 10n ** 18n }; // basic = 4980 JPYC/年
  hold.verifyThrows = false;
  hold.kvSetValue = 'OK';
  hold.kvSetOk = true;
  hold.kvGetValue = 'pending';
  hold2.grantOk = true;
  grantSpy.mockClear();
  kvSetSpy.mockClear();
  kvGetSpy.mockClear();
  kvDelSpy.mockClear();
});

describe('POST /api/fee/verify', () => {
  it('billing OFF → 404 billing_disabled', async () => {
    hold.enableBilling = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'billing_disabled' });
  });

  it('FEE_RECEIVER 未設定 (burn) → 503 billing_misconfigured・claim もしない', async () => {
    hold.feeReceiverConfigured = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'billing_misconfigured' });
    expect(kvSetSpy).not.toHaveBeenCalled(); // burn 先への送金を付与しない
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(401);
  });

  it('不正な txHash → 400', async () => {
    const res = await POST(req({ txHash: '0xabc', chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_txhash' });
  });

  it('不正な tier → 400', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'gold' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_tier' });
  });

  it('本文が JSON でない → 400 invalid_json', async () => {
    const bad = new Request('http://localhost/api/fee/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('chainId が整数でない (float) → 400 invalid_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 1.5, tier: 'basic' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_chain' });
  });

  it('JPYC 非対応 chain → 400 unsupported_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 84532, tier: 'basic' })); // baseSepolia=USDC
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unsupported_chain' });
  });

  it('idempotency: 処理中ロックが既存 (nx 失敗・結果未確定) → 409 already_processed・grant せず', async () => {
    hold.kvSetValue = null; // nx: 既存
    hold.kvGetValue = 'pending'; // ロックのみ (結果なし)
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(409);
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('idempotency replay: 確定結果が既存 → 200 で同じ結果を返し再付与しない', async () => {
    hold.kvSetValue = null; // nx: 既存
    hold.kvGetValue = `r:${JSON.stringify({ tier: 'pro', expiresAt: 1_888_000 })}`;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      tier: 'pro',
      expiresAt: 1_888_000,
      replay: true,
    });
    expect(grantSpy).not.toHaveBeenCalled(); // 再付与しない → 満了の暗黙延長なし
    expect(kvDelSpy).not.toHaveBeenCalled();
  });

  it('on-chain 検証失敗 → 422 + idempotency を release (kvDel) し grant せず', async () => {
    hold.verify = { ok: false, reason: 'amount_too_low' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'amount_too_low' });
    expect(kvDelSpy).toHaveBeenCalledOnce(); // release
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('RPC/transport 障害 (rpc_error) → 503 verify_unavailable + release・422 にしない', async () => {
    hold.verify = { ok: false, reason: 'rpc_error' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(503); // 顧客の誤 tx (422) でなく retryable
    expect(await res.json()).toMatchObject({ error: 'verify_unavailable' });
    expect(kvDelSpy).toHaveBeenCalledOnce(); // ロック解放 → 復旧後に再提出可
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('検証成功 → grant(tier) + 200 {tier,expiresAt}', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tier: 'basic', expiresAt: 999_000 });
    // grantEntitlement(wallet, 'basic', 365) が呼ばれる (basic = 年額 = TIER_PERIOD_DAYS.basic)
    expect(grantSpy).toHaveBeenCalledWith(
      hold.session.ok ? hold.session.address : '',
      'basic',
      365,
    );
    expect(kvDelSpy).not.toHaveBeenCalled(); // 成功時は release しない
  });

  it('検証は成功だが利用権の永続化に失敗 → 503 grant_failed + release (kvDel)', async () => {
    hold2.grantOk = false; // KV 書込 NG
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'grant_failed' });
    expect(grantSpy).toHaveBeenCalledOnce();
    expect(kvDelSpy).toHaveBeenCalledOnce(); // 「支払い済なのに焼失」を防ぐため claim を解放
  });

  it('検証中の想定外 throw (RPC 不通等) → 503 + claim を release (txHash 焼失防止)', async () => {
    hold.verifyThrows = true;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'verify_unavailable' });
    expect(kvDelSpy).toHaveBeenCalledOnce(); // claim を解放 → 再提出可能
    expect(grantSpy).not.toHaveBeenCalled();
  });
});
