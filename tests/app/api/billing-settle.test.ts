import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const JPYC = 10n ** 18n;

const hold = vi.hoisted(() => ({
  enableBilling: true,
  feeReceiverConfigured: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  meterCount: 10,
  meterVolume: 10_000n * 10n ** 18n, // 10,000 JPYC 出来高
  verify: { ok: true } as { ok: true } | { ok: false; reason: string },
  verifyThrows: false,
  grantOk: true,
  kvSetValue: 'OK' as 'OK' | null,
  kvSetOk: true,
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
      get enableUsageFee() {
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
// インボイスは loadUsageInvoice (export) を差し替えて制御する (route はこの export を直接 import)。
// feeWei = 出来高 × 1% を mock 内で再現し、0 で nothingDue を起こす。
vi.mock('@/lib/billingMeter', () => ({
  loadUsageInvoice: async (period: string) => {
    const feeWei = hold.meterVolume / 100n; // 1%
    return {
      period,
      count: hold.meterCount,
      volumeWei: hold.meterVolume,
      rateBps: feeWei === 0n ? 0 : 100,
      feeWei,
      free: feeWei === 0n,
    };
  },
}));
const grantSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/feeCurrent', () => ({
  isFeeCurrent: async () => false,
  grantFeeCurrent: (...args: unknown[]) => {
    grantSpy(...args);
    return Promise.resolve({ ok: hold.grantOk, expiresAt: 999_000 });
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

import { POST } from '@/app/api/billing/settle/route';

const TXHASH = `0x${'1'.repeat(64)}`;
const AMOY = 80002;

function req(body: unknown): Request {
  return new Request('http://localhost/api/billing/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hold.enableBilling = true;
  hold.feeReceiverConfigured = true;
  hold.session = { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' };
  hold.meterCount = 10;
  hold.meterVolume = 10_000n * JPYC;
  hold.verify = { ok: true };
  hold.verifyThrows = false;
  hold.grantOk = true;
  hold.kvSetValue = 'OK';
  hold.kvSetOk = true;
  hold.kvGetValue = 'pending';
  grantSpy.mockClear();
  kvSetSpy.mockClear();
  kvGetSpy.mockClear();
  kvDelSpy.mockClear();
});

describe('POST /api/billing/settle', () => {
  it('billing OFF → 404', async () => {
    hold.enableBilling = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(404);
  });

  it('FEE_RECEIVER 未設定 → 503・付与しない', async () => {
    hold.feeReceiverConfigured = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(401);
  });

  it('請求 0 (前月出来高 0) → nothingDue・付与もロックもしない (P1: 0円期間で current を得る余地なし)', async () => {
    hold.meterVolume = 0n;
    hold.meterCount = 0;
    const res = await POST(req({ chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, nothingDue: true, feeWei: '0' });
    expect(grantSpy).not.toHaveBeenCalled();
    expect(kvSetSpy).not.toHaveBeenCalled();
  });

  it('正常: 出来高 1% を検証→決定的 expiry で fee-current 付与', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, expiresAt: 999_000 });
    expect(json.feeWei).toBe((100n * JPYC).toString()); // 10,000 × 1%
    expect(json.period).toMatch(/^\d{4}-\d{2}$/);
    // grant は txHash + 決定的 expiresAt(number) 付き。
    expect(grantSpy).toHaveBeenCalledWith(
      hold.session.ok ? hold.session.address : '',
      expect.objectContaining({ txHash: TXHASH, expiresAt: expect.any(Number) }),
    );
  });

  it('請求ありで txHash 無し → 400', async () => {
    const res = await POST(req({ chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_txhash' });
  });

  it('検証失敗 (amount_too_low) → 422・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'amount_too_low' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'amount_too_low' });
    expect(kvDelSpy).toHaveBeenCalled();
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('RPC エラー → 503・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'rpc_error' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('同 txHash 再提出 (確定済) → replay・再付与しない', async () => {
    hold.kvSetValue = null;
    hold.kvGetValue = `r:${JSON.stringify({ period: '2026-05', expiresAt: 777_000 })}`;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, replay: true, expiresAt: 777_000 });
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('処理中 (ロックのみ) → 409', async () => {
    hold.kvSetValue = null;
    hold.kvGetValue = 'pending';
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(409);
  });

  it('付与の KV 書込失敗 → 503・ロック解放', async () => {
    hold.grantOk = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'grant_failed' });
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('verify が想定外 throw → 503・ロック解放', async () => {
    hold.verifyThrows = true;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(kvDelSpy).toHaveBeenCalled();
  });

  // --- 無効入力 / エラーハンドリング ---
  it('不正な JSON body → 400 invalid_json', async () => {
    const bad = new Request('http://localhost/api/billing/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('chainId 非整数 → 400 invalid_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_chain' });
  });

  it('未対応チェーン → 400 unsupported_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 999999 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unsupported_chain' });
  });

  it('請求ありで txHash の形式不正 (短い) → 400 invalid_txhash', async () => {
    const res = await POST(req({ txHash: '0xabc', chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_txhash' });
  });
});
