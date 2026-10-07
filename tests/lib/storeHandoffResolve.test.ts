import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, type Hex } from 'viem';
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
let now: number;
const spy = { expired: vi.fn(), used: vi.fn() };

function deps(over: Partial<StoreHandoffResolveDeps> = {}): StoreHandoffResolveDeps {
  return {
    expectedChainId: CHAIN,
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
    findAuthorizationUsedTransactionHash: async () => foundTx,
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
  now = VALID_BEFORE + 10;
  spy.expired.mockClear();
  spy.used.mockClear();
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

  it('使用済みで Settled が見つからない: 期限 + 5 分までは確認中、その後は「結果を確かめられない」(ロックを外す)', async () => {
    used = true;
    now = VALID_BEFORE + USED_UNRESOLVED_AFTER_SEC;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'pending' });
    clearStoreHandoffResolveCache();
    now = VALID_BEFORE + USED_UNRESOLVED_AFTER_SEC + 1;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'used_unresolved' });
    expect(spy.expired).not.toHaveBeenCalled();
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
