import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const JPYC = 10n ** 18n;
// Pro 価格 500 JPYC を block timestamp 起点で 30 日付与する route のテスト。
// 検証 (feeVerify) と grant (proPlan) は境界モックし、route の分岐 (flag/503/202/400/replay/
// cross-wallet/crash-retry 冪等) を実走で確認する。

const SESSION_ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER_ADDR = '0x1111111111111111111111111111111111111111';

const hold = vi.hoisted(() => ({
  enablePro: true,
  feeReceiverConfigured: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  // feeVerify 結果 (成功時は blockNumber 込み)。
  verify: { ok: true, value: 500n * 10n ** 18n, blockNumber: 42n } as
    | { ok: true; value: bigint; blockNumber?: bigint }
    | { ok: false; reason: string },
  verifyThrows: false,
  // block timestamp (秒)。route が *1000 して +30日 を grant する。
  blockTimestampSec: 1_750_000_000,
  blockThrows: false,
  grantOk: true,
  grantExpiresAt: 1_750_000_000_000 + 30 * 86_400_000,
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
      get enablePro() {
        return hold.enablePro;
      },
      get feeReceiverConfigured() {
        return hold.feeReceiverConfigured;
      },
    },
  };
});

// createPublicClient.getBlock を stub (実 RPC に出ない・block timestamp を制御)。
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBlock: () => {
        if (hold.blockThrows) return Promise.reject(new Error('rpc down'));
        return Promise.resolve({ timestamp: BigInt(hold.blockTimestampSec) });
      },
    }),
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

const verifySpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/feeVerify', () => ({
  verifyJpycFeeOnChain: (...args: unknown[]) => {
    verifySpy(...args);
    if (hold.verifyThrows) throw new Error('rpc down');
    return Promise.resolve(hold.verify);
  },
}));

const grantSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/proPlan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/proPlan')>();
  return {
    ...actual,
    grantPro: (...args: unknown[]) => {
      grantSpy(...args);
      return Promise.resolve({
        ok: hold.grantOk,
        expiresAt: hold.grantExpiresAt,
      });
    },
  };
});

const revenueSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/proRevenue', () => ({
  recordProRevenue: (...args: unknown[]) => {
    revenueSpy(...args);
    return Promise.resolve();
  },
}));

const kvSetSpy = vi.hoisted(() => vi.fn());
const kvDelSpy = vi.hoisted(() => vi.fn());
const kvGetSpy = vi.hoisted(() => vi.fn());
const kvEvalSpy = vi.hoisted(() => vi.fn());
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
  kvEval: (...args: unknown[]) => {
    kvEvalSpy(...args);
    return Promise.resolve({ ok: true, value: 1 });
  },
}));

import { POST } from '@/app/api/pro/subscribe/route';

const TXHASH = `0x${'1'.repeat(64)}`;
const AMOY = 80002;

function req(body: unknown): Request {
  return new Request('http://localhost/api/pro/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hold.enablePro = true;
  hold.feeReceiverConfigured = true;
  hold.session = { ok: true, address: SESSION_ADDR };
  hold.verify = { ok: true, value: 500n * JPYC, blockNumber: 42n };
  hold.verifyThrows = false;
  hold.blockTimestampSec = 1_750_000_000;
  hold.blockThrows = false;
  hold.grantOk = true;
  hold.grantExpiresAt = 1_750_000_000_000 + 30 * 86_400_000;
  hold.kvSetValue = 'OK';
  hold.kvSetOk = true;
  hold.kvGetValue = 'pending';
  verifySpy.mockClear();
  grantSpy.mockClear();
  revenueSpy.mockClear();
  kvSetSpy.mockClear();
  kvGetSpy.mockClear();
  kvDelSpy.mockClear();
  kvEvalSpy.mockClear();
});

describe('POST /api/pro/subscribe', () => {
  it('flag OFF → 404 (認証/KV より前・付与しない)', async () => {
    hold.enablePro = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(404);
    expect(grantSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
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

  it('成功: 500 JPYC 検証 → block timestamp + 30日 を決定論的に付与', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      wallet: SESSION_ADDR,
      expiresAt: hold.grantExpiresAt,
    });
    // grant は (wallet, blockTs*1000 + 30日)。決定論 = now() ではなく block 由来。
    expect(grantSpy).toHaveBeenCalledWith(
      SESSION_ADDR,
      hold.blockTimestampSec * 1000 + 30 * 86_400_000,
    );
    // 収益記録は txHash 込みで 1 回。
    expect(revenueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: SESSION_ADDR, txHash: TXHASH, chainId: AMOY }),
    );
  });

  it('from 束縛: verify に from=session・to=feeReceiver・token=JPYC・minValue=500e18 を渡す', async () => {
    await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(verifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TXHASH,
        expected: expect.objectContaining({
          from: SESSION_ADDR,
          to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          minValue: 500n * JPYC,
        }),
      }),
    );
  });

  it('額不足 (amount_too_low) → 400 insufficient_payment・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'amount_too_low' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'insufficient_payment' });
    expect(kvDelSpy).toHaveBeenCalled();
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('別 from (recover forwarder 等) → no_matching_transfer → 400 insufficient_payment', async () => {
    hold.verify = { ok: false, reason: 'no_matching_transfer' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'insufficient_payment' });
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('tx_not_found → 202 (再送金させず再検証導線)・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'tx_not_found' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ error: 'tx_not_found' });
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('rpc_error → 503 (retryable)・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'rpc_error' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('tx_reverted → 400・ロック解放', async () => {
    hold.verify = { ok: false, reason: 'tx_reverted' };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'tx_reverted' });
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('block timestamp 取得失敗 → 503・ロック解放・付与しない', async () => {
    hold.blockThrows = true;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(kvDelSpy).toHaveBeenCalled();
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('blockNumber 欠落の verify 結果 → 503 (決定論付与不能)', async () => {
    hold.verify = { ok: true, value: 500n * JPYC }; // blockNumber 無し
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('grant の KV 書込失敗 → 503 grant_failed・ロック解放', async () => {
    hold.grantOk = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'grant_failed' });
    expect(kvDelSpy).toHaveBeenCalled();
  });

  it('同 wallet 再提出 (確定済) → replay・格納 expiresAt 返却・再付与/再課金なし', async () => {
    hold.kvSetValue = null; // nx claim 失敗 (既存)
    hold.kvGetValue = `r:${JSON.stringify({ wallet: SESSION_ADDR, expiresAt: 888_000 })}`;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      replay: true,
      expiresAt: 888_000,
      wallet: SESSION_ADDR,
    });
    expect(grantSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('別 wallet 再提出 (同 txHash) → 400 used_by_other_wallet・付与しない', async () => {
    hold.session = { ok: true, address: OTHER_ADDR };
    hold.kvSetValue = null;
    hold.kvGetValue = `r:${JSON.stringify({ wallet: SESSION_ADDR, expiresAt: 888_000 })}`;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'used_by_other_wallet' });
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('処理中 (短ロックのみ・未昇格) → 409', async () => {
    hold.kvSetValue = null;
    hold.kvGetValue = 'pending';
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(409);
  });

  it('crash 後 retry: 同 tx 再検証 → 同 block 由来の同 target で再 grant (冪等・二重extendなし)', async () => {
    // 1 回目成功 (block ts 由来の target を grant)。
    await POST(req({ txHash: TXHASH, chainId: AMOY }));
    const firstTarget = grantSpy.mock.calls[0][1];
    grantSpy.mockClear();
    // promote 失敗を想定して再提出 (claim を取り直す = kvSetValue 'OK' のまま)。同 block ts。
    await POST(req({ txHash: TXHASH, chainId: AMOY }));
    const secondTarget = grantSpy.mock.calls[0][1];
    // 同じ block timestamp 由来なので target は同一 = atomic max で +30日 を重ねない。
    expect(secondTarget).toBe(firstTarget);
  });

  it('不正な JSON body → 400 invalid_json', async () => {
    const bad = new Request('http://localhost/api/pro/subscribe', {
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

  it('txHash 形式不正 (短い) → 400 invalid_txhash', async () => {
    const res = await POST(req({ txHash: '0xabc', chainId: AMOY }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_txhash' });
  });

  it('未対応チェーン → 400 unsupported_chain', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: 999999 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unsupported_chain' });
  });

  it('verify が想定外 throw → 503・ロック解放', async () => {
    hold.verifyThrows = true;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(kvDelSpy).toHaveBeenCalled();
  });
});
