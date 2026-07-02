import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const JPYC = 10n ** 18n;
// CSV パス価格 100 JPYC を block timestamp 起点で 24時間付与する route のテスト。
// 検証 (feeVerify) と grant (csvPass) は境界モックし、route の分岐 (flag/503/202/400/replay/
// cross-wallet/crash-retry 冪等) を実走で確認する (pro-subscribe.test と同型・engine 共有)。

const SESSION_ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER_ADDR = '0x1111111111111111111111111111111111111111';
const GRANT_MS = 24 * 3_600_000; // 86_400_000

const hold = vi.hoisted(() => ({
  enableCsvPass: true,
  feeReceiverConfigured: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  // feeVerify 結果 (成功時は blockNumber 込み)。
  verify: { ok: true, value: 100n * 10n ** 18n, blockNumber: 42n } as
    | { ok: true; value: bigint; blockNumber?: bigint }
    | { ok: false; reason: string },
  verifyThrows: false,
  // block timestamp (秒)。route が *1000 して +24時間 を grant する。
  blockTimestampSec: 1_750_000_000,
  blockThrows: false,
  grantOk: true,
  grantExpiresAt: 1_750_000_000_000 + 24 * 3_600_000,
  kvSetValue: 'OK' as 'OK' | null,
  kvSetOk: true,
  // per-call kvSet 戻りの上書きキュー (promote 失敗の検証用)。空なら既定 (kvSetOk/kvSetValue)。
  kvSetResults: [] as Array<{ ok: true; value: 'OK' | null } | { ok: false; reason: string }>,
  kvGetValue: 'pending' as string | null,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      get enableCsvPass() {
        return hold.enableCsvPass;
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
vi.mock('@/lib/csvPass', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/csvPass')>();
  return {
    ...actual,
    grantCsvPass: (...args: unknown[]) => {
      grantSpy(...args);
      return Promise.resolve({
        ok: hold.grantOk,
        expiresAt: hold.grantExpiresAt,
      });
    },
  };
});

const revenueSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/csvPassRevenue', () => ({
  recordCsvPassRevenue: (...args: unknown[]) => {
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
    const queued = hold.kvSetResults.shift();
    if (queued) return Promise.resolve(queued);
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

import { POST } from '@/app/api/csv-pass/subscribe/route';

const TXHASH = `0x${'1'.repeat(64)}`;
const AMOY = 80002;

function req(body: unknown): Request {
  return new Request('http://localhost/api/csv-pass/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hold.enableCsvPass = true;
  hold.feeReceiverConfigured = true;
  hold.session = { ok: true, address: SESSION_ADDR };
  hold.verify = { ok: true, value: 100n * JPYC, blockNumber: 42n };
  hold.verifyThrows = false;
  hold.blockTimestampSec = 1_750_000_000;
  hold.blockThrows = false;
  hold.grantOk = true;
  hold.grantExpiresAt = 1_750_000_000_000 + GRANT_MS;
  hold.kvSetValue = 'OK';
  hold.kvSetOk = true;
  hold.kvSetResults = [];
  hold.kvGetValue = 'pending';
  verifySpy.mockClear();
  grantSpy.mockClear();
  revenueSpy.mockClear();
  kvSetSpy.mockClear();
  kvGetSpy.mockClear();
  kvDelSpy.mockClear();
  kvEvalSpy.mockClear();
});

describe('POST /api/csv-pass/subscribe', () => {
  it('flag OFF → 404 (認証/KV より前・付与しない)', async () => {
    hold.enableCsvPass = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'csvpass_disabled' });
    expect(grantSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('FEE_RECEIVER 未設定 → 503・付与しない', async () => {
    hold.feeReceiverConfigured = false;
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'csvpass_misconfigured' });
    expect(grantSpy).not.toHaveBeenCalled();
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(401);
  });

  it('成功: 100 JPYC 検証 → block timestamp + 24時間 を決定論的に付与', async () => {
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      wallet: SESSION_ADDR,
      expiresAt: hold.grantExpiresAt,
    });
    // grant は (wallet, blockTs*1000 + 24時間)。決定論 = now() ではなく block 由来。
    expect(grantSpy).toHaveBeenCalledWith(
      SESSION_ADDR,
      hold.blockTimestampSec * 1000 + GRANT_MS,
    );
    // 収益記録は txHash 込みで 1 回。額 = 実 on-chain 受領値・計上時点 = block timestamp
    // (Date.now() ではない) を**厳密に**固定する (Codex P3: 緩い assertion だと regress を見逃す)。
    expect(revenueSpy).toHaveBeenCalledTimes(1);
    expect(revenueSpy).toHaveBeenCalledWith({
      wallet: SESSION_ADDR,
      priceWei: 100n * JPYC, // verify が返した実 on-chain value
      chainId: AMOY,
      txHash: TXHASH,
      paidAtMs: hold.blockTimestampSec * 1000, // block 由来 (遅延 claim でも正しい期)
    });
  });

  it('overpay (150 JPYC): 台帳には実受領値が乗り、付与は 24時間 1 期間のみ', async () => {
    hold.verify = { ok: true, value: 150n * JPYC, blockNumber: 42n };
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    // 付与 target は額に依らず block ts + 24h (按分/積み増しなし)。
    expect(grantSpy).toHaveBeenCalledWith(
      SESSION_ADDR,
      hold.blockTimestampSec * 1000 + GRANT_MS,
    );
    // 台帳は超過分も正しく実額で記録する。
    expect(revenueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ priceWei: 150n * JPYC }),
    );
  });

  it('from 束縛: verify に from=session・to=feeReceiver・token=JPYC・minValue=100e18 を渡す', async () => {
    await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(verifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TXHASH,
        expected: expect.objectContaining({
          from: SESSION_ADDR,
          to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          minValue: 100n * JPYC,
        }),
      }),
    );
  });

  it('used-key 名前空間が csvpass:used: (pro と非共有)', async () => {
    await POST(req({ txHash: TXHASH, chainId: AMOY }));
    // 最初の kvSet は nx claim (usedKey)。csvpass:used: prefix を確認する。
    expect(kvSetSpy.mock.calls[0][0]).toBe(`csvpass:used:${AMOY}:${TXHASH.toLowerCase()}`);
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
    hold.verify = { ok: true, value: 100n * JPYC }; // blockNumber 無し
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

  it('promote (結果昇格) 失敗は tolerate して 200 を返す (付与は確定済)', async () => {
    // kvSet は 2 回呼ばれる: (1) nx claim → OK、(2) 結果昇格 (r: prefix)。昇格を失敗させても
    // grant は atomic max で冪等なので決済は壊さず 200 を返す (settle 同型・engine の promote-failed 分岐)。
    hold.kvSetResults = [
      { ok: true, value: 'OK' }, // claim
      { ok: true, value: 'OK' }, // cross-tier claim
      { ok: true, value: 'OK' }, // cross-tier promote
      { ok: false, reason: 'network_error' }, // per-tier promote 失敗
    ];
    const res = await POST(req({ txHash: TXHASH, chainId: AMOY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, wallet: SESSION_ADDR });
    // 昇格が失敗しても付与 (grant) は確定済み。
    expect(grantSpy).toHaveBeenCalled();
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

  it('crash 後 retry: 同 tx 再検証 → 同 block 由来の同 target で再 grant (冪等・二重付与なし)', async () => {
    await POST(req({ txHash: TXHASH, chainId: AMOY }));
    const firstTarget = grantSpy.mock.calls[0][1];
    grantSpy.mockClear();
    await POST(req({ txHash: TXHASH, chainId: AMOY }));
    const secondTarget = grantSpy.mock.calls[0][1];
    // 同じ block timestamp 由来なので target は同一 = atomic max で +24h を重ねない。
    expect(secondTarget).toBe(firstTarget);
  });

  it('不正な JSON body → 400 invalid_json', async () => {
    const bad = new Request('http://localhost/api/csv-pass/subscribe', {
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
