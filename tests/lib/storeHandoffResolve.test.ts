import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { buildForwarderNonce } from '@/lib/relay/forwarderIntent';
import { resolveStoreHandoff, type StoreHandoffResolveDeps } from '@/lib/storeHandoffResolve';

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
const NONCE = buildForwarderNonce(
  { from: PAYER, merchant: SHOP, merchantValue: BILL, feeReceiver: FEE, feeValue: 1n, validAfter: 0n, validBefore: 1000n, intentSalt: SALT },
  CHAIN,
  FWD,
);

let matchTx: Hex | null;
let used: boolean;
let foundTx: Hex | null;
let expiredUnused: boolean;
const calls = { expired: vi.fn(), match: vi.fn() };

function deps(over: Partial<StoreHandoffResolveDeps> = {}): StoreHandoffResolveDeps {
  return {
    expectedChainId: CHAIN,
    jpycAddressFor: () => JPYC,
    forwarderFor: () => FWD,
    feeReceiverFor: () => FEE,
    successfulReceiptLogs: async (_c, tx) => (tx === matchTx || tx === OTHER_TX ? [{ tx } as never] : null),
    hasMatchingSettlement: (logs, forwarder, payer, nonce, split) => {
      calls.match(forwarder, payer, nonce, split);
      return (logs[0] as unknown as { tx: Hex }).tx === matchTx && nonce === NONCE;
    },
    readAuthorizationUsed: async () => used,
    findAuthorizationUsedTransactionHash: async () => foundTx,
    expiredUnused: async (input) => {
      calls.expired(input);
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
  validBefore: '1000',
  intentSalt: SALT,
  ...over,
});

beforeEach(() => {
  matchTx = null;
  used = false;
  foundTx = null;
  expiredUnused = false;
  calls.expired.mockClear();
  calls.match.mockClear();
});

describe('resolveStoreHandoff (お店の端末で送る 1 件の結論)', () => {
  it('端末が知らせた tx の receipt に、この支払いの Settled があれば支払い済み', async () => {
    matchTx = TX;
    expect(await resolveStoreHandoff(body({ txHash: TX }), deps())).toEqual({ ok: true, state: 'settled', txHash: TX });
    expect(calls.match).toHaveBeenCalledWith(FWD, PAYER, NONCE, { merchant: SHOP, merchantValue: BILL, feeReceiver: FEE, feeValue: 1n });
  });

  it('別の取引・revert・置換の tx は支払いの証明にしない (この nonce の tx を探し直す)', async () => {
    used = true;
    foundTx = TX;
    matchTx = TX;
    expect(await resolveStoreHandoff(body({ txHash: OTHER_TX }), deps())).toEqual({ ok: true, state: 'settled', txHash: TX });
  });

  it('使用済みでも Settled が見つからない (取消の可能性) なら確認中のまま', async () => {
    used = true;
    foundTx = OTHER_TX;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'pending' });
    expect(calls.expired).not.toHaveBeenCalled();
  });

  it('未使用: 確定ブロックで期限切れ・未使用を確かめたときだけ「行われていない」', async () => {
    expiredUnused = false;
    expect(await resolveStoreHandoff(body(), deps())).toEqual({ ok: true, state: 'pending' });
    expiredUnused = true;
    expect(await resolveStoreHandoff(body({ txHash: OTHER_TX }), deps())).toEqual({ ok: true, state: 'expired_unused' });
    expect(calls.expired).toHaveBeenLastCalledWith({ chainId: CHAIN, token: JPYC, payer: PAYER, nonce: NONCE, validBefore: 1000n, txHash: OTHER_TX });
  });

  it('RPC 障害は結論を出さない', async () => {
    expect(
      await resolveStoreHandoff(body(), deps({ readAuthorizationUsed: async () => { throw new Error('rpc'); } })),
    ).toEqual({ ok: true, state: 'pending' });
  });

  it('値をごまかしても別の nonce になるだけ (他人の支払いを支払い済みにできない)', async () => {
    matchTx = TX;
    const r = await resolveStoreHandoff(body({ merchantValue: '1', txHash: TX }), deps());
    expect(r).not.toMatchObject({ state: 'settled' });
  });

  it.each([
    [{ chainId: 137 }],
    [{ from: '0x1' }],
    [{ merchantValue: '1.5' }],
    [{ intentSalt: '0x12' }],
    [{ txHash: '0x12' }],
  ])('形が違う本文は 400 (%o)', async (over) => {
    expect(await resolveStoreHandoff(body(over), deps())).toMatchObject({ ok: false, status: 400 });
  });
});
