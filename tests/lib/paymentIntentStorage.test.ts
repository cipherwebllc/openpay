import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  RELAY_INTENT_STORAGE_KEY,
  STANDARD_INTENT_STORAGE_KEY,
  clearRelayIntent,
  loadRelayIntent,
  loadStandardIntent,
  saveRelayIntent,
  saveStandardIntent,
  type RelayIntentMetadata,
  type StandardIntentMetadata,
} from '@/lib/paymentIntentStorage';

const FROM = '0x1111111111111111111111111111111111111111' as Address;
const MERCHANT =
  '0x2222222222222222222222222222222222222222' as Address;
const NONCE = `0x${'3'.repeat(64)}` as Hex;
const SIGNATURE = `0x${'4'.repeat(130)}` as Hex;
const TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const FEE_RECEIVER =
  '0x4444444444444444444444444444444444444444' as Address;
const MERCHANT_TX = `0x${'5'.repeat(64)}` as Hex;
const FEE_TX = `0x${'6'.repeat(64)}` as Hex;
const CONTEXT_KEY = `0x${'9'.repeat(64)}` as Hex;

function relayIntent(): RelayIntentMetadata {
  return {
    chainId: 80002,
    from: FROM,
    merchant: MERCHANT,
    merchantValue: '1000000000000000000',
    feeValue: '2000000000000000000',
    nonce: NONCE,
    validBefore: '9999999999',
    routeKind: 'recover',
    issuedAt: 1_700_000_000_000,
  };
}

function standardIntent(): StandardIntentMetadata {
  return {
    version: 1,
    chainId: 84532,
    from: FROM,
    tokenAddress: TOKEN,
    merchant: MERCHANT,
    merchantValue: '990000',
    feeReceiver: FEE_RECEIVER,
    feeValue: '10000',
    saleValue: '1000000',
    stage: 'fee',
    merchantTxHash: MERCHANT_TX,
    feeTxHash: FEE_TX,
    merchantBlockNumber: '123',
    contextKey: CONTEXT_KEY,
    issuedAt: 1_700_000_000_000,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('relay payment intent sessionStorage', () => {
  it('公開 metadata だけを保存し、signature / signed payload を書き込まない', () => {
    const input = {
      ...relayIntent(),
      signature: SIGNATURE,
      payload: { signature: SIGNATURE },
      contextKey: `0x${'9'.repeat(64)}`,
      gasMode: 'merchant',
      feeKind: 'storefront',
    } as RelayIntentMetadata & {
      signature: Hex;
      payload: { signature: Hex };
      contextKey: string;
      gasMode: string;
      feeKind: string;
    };

    saveRelayIntent(input);

    const raw = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(SIGNATURE);
    expect(raw).not.toContain('contextKey');
    expect(raw).not.toContain('gasMode');
    expect(raw).not.toContain('feeKind');
    expect(JSON.parse(raw!)).toEqual(relayIntent());
    expect(loadRelayIntent()).toEqual(relayIntent());
  });

  it('壊れた値は破棄して新規支払いを妨げない', () => {
    window.sessionStorage.setItem(
      RELAY_INTENT_STORAGE_KEY,
      JSON.stringify({
        ...relayIntent(),
        nonce: '0x1234',
      }),
    );

    expect(loadRelayIntent()).toBeNull();
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).toBeNull();
  });

  it('旧/将来の追加 field は復元値へ持ち込まない', () => {
    window.sessionStorage.setItem(
      RELAY_INTENT_STORAGE_KEY,
      JSON.stringify({
        ...relayIntent(),
        contextKey: `0x${'9'.repeat(64)}`,
        signature: SIGNATURE,
      }),
    );

    expect(loadRelayIntent()).toEqual(relayIntent());
  });

  it('sessionStorage 障害を save/load/clear から決済本体へ throw しない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveRelayIntent(relayIntent())).not.toThrow();
    vi.restoreAllMocks();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadRelayIntent()).toBeNull();
    vi.restoreAllMocks();

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => clearRelayIntent()).not.toThrow();
  });
});

describe('standard payment intent sessionStorage', () => {
  it('broadcast hash と公開 metadata だけを whitelist 保存する', () => {
    const input = {
      ...standardIntent(),
      unexpectedSecret: SIGNATURE,
    } as StandardIntentMetadata & {
      unexpectedSecret: Hex;
    };

    saveStandardIntent(input);

    const raw = window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(SIGNATURE);
    expect(JSON.parse(raw!)).toEqual(standardIntent());
    expect(loadStandardIntent()).toEqual(standardIntent());
  });

  it('注文照合用 contextKey は digest だけを保存し、不正な digest は破棄する', () => {
    saveStandardIntent(standardIntent());
    expect(loadStandardIntent()?.contextKey).toBe(CONTEXT_KEY);

    window.sessionStorage.setItem(
      STANDARD_INTENT_STORAGE_KEY,
      JSON.stringify({
        ...standardIntent(),
        contextKey: 'checkout:raw-order-context',
      }),
    );

    expect(loadStandardIntent()).toBeNull();
    expect(
      window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY),
    ).toBeNull();
  });

  it('register fee marker は true だけ round-trip する', () => {
    saveStandardIntent({ ...standardIntent(), registerFee: true });
    expect(loadStandardIntent()?.registerFee).toBe(true);

    window.sessionStorage.setItem(
      STANDARD_INTENT_STORAGE_KEY,
      JSON.stringify({
        ...standardIntent(),
        registerFee: 'yes',
      }),
    );
    expect(loadStandardIntent()).toBeNull();
  });

  it('fee 復旧に必要な hash/block が欠けた record は破棄する', () => {
    window.sessionStorage.setItem(
      STANDARD_INTENT_STORAGE_KEY,
      JSON.stringify({
        ...standardIntent(),
        stage: 'fee-awaiting',
        feeTxHash: undefined,
        merchantBlockNumber: undefined,
      }),
    );

    expect(loadStandardIntent()).toBeNull();
    expect(
      window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY),
    ).toBeNull();
  });
});
