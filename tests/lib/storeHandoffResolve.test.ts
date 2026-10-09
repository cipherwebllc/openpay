import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, maxUint256, type Hex } from 'viem';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import {
  USED_UNRESOLVED_AFTER_SEC,
  clearStoreHandoffResolveCache,
  resolveStoreHandoff,
  type StoreHandoffResolveDeps,
} from '@/lib/storeHandoffResolve';

const CHAIN = 80002;
const JPYC = getAddress('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
const FWD = getAddress('0x752B7AaD0089286EB7b553d84D05233d80c9FCB4');
const FEE = getAddress('0x428483FbA62eDCef1E3a100d3799F6d71759c560');
const SHOP = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const PAYER = getAddress('0x0000000000000000000000000000000000000def');
const BILL = 1000n * 10n ** 18n;
const SALT = `0x${'11'.repeat(32)}` as Hex;
const TX = `0x${'ab'.repeat(32)}` as Hex;
const OTHER_TX = `0x${'cd'.repeat(32)}` as Hex;
const BLOCK_HASH = `0x${'ef'.repeat(32)}` as Hex;
const VALID_BEFORE = 1000;
const NONCE = buildForwarderNonce(
  { from: PAYER, merchant: SHOP, merchantValue: BILL, feeReceiver: FEE, feeValue: 1n, validAfter: 0n, validBefore: BigInt(VALID_BEFORE), intentSalt: SALT },
  CHAIN,
  FWD,
);

let matchTx: Hex | null;
let finalized: boolean;
let used: boolean;
let foundTx: Hex | null;
let expiredUnused: boolean;
let usedFinal: boolean;
let now: number;
const spy = { expired: vi.fn(), used: vi.fn(), find: vi.fn() };

function deps(over: Partial<StoreHandoffResolveDeps> = {}): StoreHandoffResolveDeps {
  return {
    isConfiguredChain: (id) => id === CHAIN,
    nowSec: () => now,
    jpycAddressFor: () => JPYC,
    forwarderFor: () => FWD,
    feeReceiverFor: () => FEE,
    successfulReceipt: async (_c: number, tx: Hex) =>
      tx === matchTx || tx === OTHER_TX ? { logs: [{ tx } as never], blockNumber: 5n, blockHash: BLOCK_HASH } : null,
    isFinalizedCanonical: async () => finalized,
    hasMatchingSettlement: (logs, _f, _p, nonce) => (logs[0] as unknown as { tx: Hex }).tx === matchTx && nonce === NONCE,
    readAuthorizationUsed: async () => {
      spy.used();
      return used;
    },
    usedAtFinalized: async () => usedFinal,
    findAuthorizationUsedTransactionHash: async (_c, _t, _f, _n, window) => {
      spy.find(window);
      return foundTx;
    },
    expiredUnused: async (input) => {
      spy.expired(input);
      return expiredUnused;
    },
    ...over,
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  chainId: CHAIN,
  from: PAYER,
  merchant: SHOP,
  merchantValue: BILL.toString(),
  validBefore: String(VALID_BEFORE),
  intentSalt: SALT,
  nonce: NONCE,
  forwarder: FWD,
  feeReceiver: FEE,
  ...over,
});

beforeEach(() => {
  clearStoreHandoffResolveCache();
  matchTx = null;
  finalized = true;
  used = false;
  foundTx = null;
  expiredUnused = false;
  usedFinal = true;
  now = VALID_BEFORE + 10;
  spy.expired.mockClear();
  spy.used.mockClear();
  spy.find.mockClear();
});

describe('resolveStoreHandoff (お店の端末で送る 1 件の結論)', () => {
  it('ヒントの tx がこの支払いの Settled を含み、確定済みのブロックなら支払い済み', async () => {
    matchTx = TX;
    expect(await resolveStoreHandoff(body({ txHash: TX }), deps())).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('一致しても未確定 (finalized 前・reorg の可能性) なら「確定待ち」の確認中', async () => {
    matchTx = TX;
    finalized = false;
    expect(await resolveStoreHandoff(body({ txHash: TX }), deps())).toEqual({ ok: true, state: 'pending', confirming: true });
  });

  it('別の取引のヒントは無視し、この nonce の tx を探し直す', async () => {
    used = true;
    foundTx = TX;
    matchTx = TX;
    expect(await resolveStoreHandoff(body({ txHash: OTHER_TX }), deps())).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('使用済みで Settled が見つからない: 期限 + 5 分まで・確定ブロックで未確認なら確認中、両方満たせば「結果を確かめられない」', async () => {
    used = true;
    now = VALID_BEFORE + USED_UNRESOLVED_AFTER_SEC;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'pending' });
    clearStoreHandoffResolveCache();
    now = VALID_BEFORE + USED_UNRESOLVED_AFTER_SEC + 1;
    usedFinal = false; // 確定ブロックではまだ使用済みでない (未確定の取消・使用)
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'pending' });
    clearStoreHandoffResolveCache();
    usedFinal = true;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'used_unresolved' });
    expect(spy.expired).not.toHaveBeenCalled();
  });

  it('tx 探しが探しきれない (RPC の範囲制限・時間切れ・遡り幅) ときは、期限から時間がたっても「結果を確かめられない」で確定させない', async () => {
    used = true;
    usedFinal = true;
    now = VALID_BEFORE + USED_UNRESOLVED_AFTER_SEC + 1;
    const incomplete = deps({
      findAuthorizationUsedTransactionHash: async () => {
        throw new Error('authorization_lookup_incomplete:lookback');
      },
    });
    expect(await resolveStoreHandoff(body(), incomplete)).toEqual({ ok: true, state: 'pending' });
  });

  it('receipt の RPC 障害は「無い」と区別し、結論を出さず覚えない', async () => {
    used = true;
    foundTx = TX;
    now = VALID_BEFORE + USED_UNRESOLVED_AFTER_SEC + 1;
    const failing = deps({ successfulReceipt: async () => { throw new Error('rpc'); } });
    expect(await resolveStoreHandoff(body(), failing)).toEqual({ ok: true, state: 'pending' });
    matchTx = TX;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('ヒントを付け替えても重い確認 (ログ検索) は短い間は繰り返さない・同時の照会は 1 回にまとめる', async () => {
    used = true;
    await Promise.all([resolveStoreHandoff(body(), deps()), resolveStoreHandoff(body(), deps())]);
    expect(spy.find).toHaveBeenCalledTimes(1);
    // tx 探しには署名の有効期限と受け渡しの有効窓の上限 (180 秒 + 時計のずれ 30 秒) を渡す (RPC の範囲制限)
    expect(spy.find).toHaveBeenCalledWith({ validAfter: 0n, validBefore: BigInt(VALID_BEFORE), maxWindowSec: 210 });
    await resolveStoreHandoff(body({ txHash: OTHER_TX }), deps());
    await resolveStoreHandoff(body({ txHash: `0x${'77'.repeat(32)}` }), deps());
    expect(spy.find).toHaveBeenCalledTimes(1);
  });

  it('ヒントの確認を待つ間に別の照会が覚えた結論を使う (ログ検索を繰り返さない)', async () => {
    used = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = deps({
      successfulReceipt: async () => {
        await gate;
        return null;
      },
    });
    const second = resolveStoreHandoff(body({ txHash: OTHER_TX }), slow);
    await resolveStoreHandoff(body(), deps());
    release();
    await second;
    expect(spy.find).toHaveBeenCalledTimes(1);
  });

  it('未使用: 確定ブロックで期限切れ・未使用のときだけ「行われていない」・無関係な tx のヒントは判定に混ぜない', async () => {
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'pending' });
    clearStoreHandoffResolveCache();
    expiredUnused = true;
    expect(await resolveStoreHandoff(body({ txHash: OTHER_TX }), deps())).toEqual({ ok: true, state: 'expired_unused' });
    expect(spy.expired).toHaveBeenLastCalledWith({ chainId: CHAIN, token: JPYC, payer: PAYER, nonce: NONCE, validBefore: BigInt(VALID_BEFORE) });
  });

  it('署名した時点の forwarder・手数料受取口が今の設定と違えば判定しない (別の nonce で未払いを誤証明しない)', async () => {
    expiredUnused = true;
    expect(await resolveStoreHandoff(body({ forwarder: SHOP }), deps())).toEqual({ ok: true, state: 'pending' });
    expect(await resolveStoreHandoff(body({ feeReceiver: SHOP }), deps())).toEqual({ ok: true, state: 'pending' });
    expect(spy.used).not.toHaveBeenCalled();
  });

  it('送られた nonce と計算し直した nonce が違えば 400', async () => {
    expect(await resolveStoreHandoff(body({ nonce: `0x${'99'.repeat(32)}` }), deps())).toMatchObject({ ok: false, error: 'nonce_mismatch' });
  });

  it('RPC 障害は結論を出さず覚えない・結論は覚えて RPC を繰り返さない', async () => {
    const failing = deps({ readAuthorizationUsed: async () => { throw new Error('rpc'); } });
    expect(await resolveStoreHandoff(body(), failing)).toEqual({ ok: true, state: 'pending' });
    expiredUnused = true;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'expired_unused' });
    spy.used.mockClear();
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'expired_unused' });
    expect(spy.used).not.toHaveBeenCalled();
  });

  // A13/G9: 78 桁の数字は uint256 を超えうる。nonce の計算 (uint256 の ABI encode) で例外 → 500 にせず、形の違う本文 (400) にする。
  // お客様が署名する額は請求額 + 1 wei なので、それが uint256 に収まらない請求額も実在しない (400)。
  it('uint256 を超える数・請求額 + 1 wei が溢れる請求額は 400 (nonce の計算で例外にしない)', async () => {
    for (const over of [
      { merchantValue: '9'.repeat(78) },
      { merchantValue: (maxUint256 + 1n).toString() },
      { merchantValue: maxUint256.toString() },
      { validBefore: '9'.repeat(78) },
      { validBefore: (maxUint256 + 1n).toString() },
    ]) {
      await expect(resolveStoreHandoff(body(over), deps())).resolves.toEqual({
        ok: false,
        status: 400,
        error: 'invalid_body',
      });
    }
    expect(spy.used).not.toHaveBeenCalled();
  });

  it('uint256 の範囲ちょうど (請求額 + 1 wei = 上限・期限 = 上限) は形として受け、nonce の照合へ進む', async () => {
    for (const over of [{ merchantValue: (maxUint256 - 1n).toString() }, { validBefore: maxUint256.toString() }]) {
      await expect(resolveStoreHandoff(body(over), deps())).resolves.toEqual({
        ok: false,
        status: 400,
        error: 'nonce_mismatch',
      });
    }
  });

  it.each([
    [{ chainId: 137 }],
    [{ from: '0x1' }],
    [{ merchantValue: '1.5' }],
    [{ intentSalt: '0x12' }],
    [{ nonce: undefined }],
    [{ txHash: '0x12' }],
  ])('形が違う本文は 400 (%o)', async (over) => {
    expect(await resolveStoreHandoff(body(over), deps())).toMatchObject({ ok: false, status: 400 });
  });
});
