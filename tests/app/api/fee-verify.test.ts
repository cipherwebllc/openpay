import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// 制御用ホルダ (各 test で差し替え)。
const hold = vi.hoisted(() => ({
  enableBilling: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  verify: { ok: true, value: 0n } as
    | { ok: true; value: bigint }
    | { ok: false; reason: string },
  // kvSet(nx) の戻り: 'OK' = 新規取得 / null = 既に存在 (二重)。
  kvSetValue: 'OK' as 'OK' | null,
  kvSetOk: true,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableBilling() {
        return hold.enableBilling;
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
  verifyJpycFeeOnChain: vi.fn(async () => hold.verify),
}));
const grantSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/entitlement', () => ({
  ENTITLEMENT_DEFAULT_DAYS: 30,
  grantEntitlement: (...args: unknown[]) => {
    grantSpy(...args);
    return Promise.resolve({ tier: args[1], expiresAt: 999_000 });
  },
}));
const kvSetSpy = vi.hoisted(() => vi.fn());
const kvDelSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  kvSet: (...args: unknown[]) => {
    kvSetSpy(...args);
    return Promise.resolve(
      hold.kvSetOk
        ? { ok: true, value: hold.kvSetValue }
        : { ok: false, reason: 'unconfigured' },
    );
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
  hold.session = { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' };
  hold.verify = { ok: true, value: 300n * 10n ** 18n };
  hold.kvSetValue = 'OK';
  hold.kvSetOk = true;
  grantSpy.mockClear();
  kvSetSpy.mockClear();
  kvDelSpy.mockClear();
});

describe('POST /api/fee/verify', () => {
  it('billing OFF → 404 billing_disabled', async () => {
    hold.enableBilling = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'billing_disabled' });
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

  it('JPYC 非対応 chain → 400 unsupported_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 84532, tier: 'basic' })); // baseSepolia=USDC
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unsupported_chain' });
  });

  it('idempotency: 既に使用済 txHash (nx 失敗) → 409 already_processed・grant せず', async () => {
    hold.kvSetValue = null; // nx: 既存
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(409);
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('on-chain 検証失敗 → 422 + idempotency を release (kvDel) し grant せず', async () => {
    hold.verify = { ok: false, reason: 'amount_too_low' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'amount_too_low' });
    expect(kvDelSpy).toHaveBeenCalledOnce(); // release
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('検証成功 → grant(tier) + 200 {tier,expiresAt}', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY, tier: 'basic' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tier: 'basic', expiresAt: 999_000 });
    // grantEntitlement(wallet, 'basic', 30) が呼ばれる
    expect(grantSpy).toHaveBeenCalledWith(
      hold.session.ok ? hold.session.address : '',
      'basic',
      30,
    );
    expect(kvDelSpy).not.toHaveBeenCalled(); // 成功時は release しない
  });
});
