import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  RELAY_INTENT_STORAGE_KEY,
  SALES_MOVE_INTENT_PROBE_KEY,
  SALES_MOVE_INTENT_STORAGE_KEY,
  STANDARD_INTENT_STORAGE_KEY,
  canStoreSalesMoveIntent,
  clearRelayIntent,
  clearSalesMoveIntent,
  loadRelayIntent,
  loadSalesMoveIntent,
  loadStandardIntent,
  saveRelayIntent,
  saveSalesMoveIntent,
  saveStandardIntent,
  saveStandardPaymentIntent,
  standardParamsFromIntent,
  type RelayIntentMetadata,
  type SalesMoveIntentMetadata,
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
const ORDER_LINK_KEY = `0x${'a7'.repeat(32)}` as Hex;

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

  it('注文リンクの支払いの指紋 (orderLinkKey) は digest だけを保存・復元する (第 9 回レビュー G-1)', () => {
    saveRelayIntent({ ...relayIntent(), orderLinkKey: ORDER_LINK_KEY });

    const raw = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({ ...relayIntent(), orderLinkKey: ORDER_LINK_KEY });
    expect(loadRelayIntent()).toEqual({ ...relayIntent(), orderLinkKey: ORDER_LINK_KEY });
  });

  it('形の崩れた orderLinkKey は落とし、未解決の支払いの intent (復旧 latch) は残す', () => {
    saveRelayIntent({ ...relayIntent(), orderLinkKey: 'order-link:raw' as Hex });
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).not.toContain('order-link:raw');

    window.sessionStorage.setItem(
      RELAY_INTENT_STORAGE_KEY,
      JSON.stringify({ ...relayIntent(), orderLinkKey: 'order-link:raw' }),
    );

    expect(loadRelayIntent()).toEqual(relayIntent());
    expect(
      window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY),
    ).not.toBeNull();
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

  it('廃止したレジ利用料の印 (registerFee) が残った旧 record も読み、印は持ち越さない (第 7 回レビュー C12)', () => {
    // 2026-10-07 の廃止前に保存された 2 tx の途中経過でも、fee の再開は続けられる。印は claim 通知の撤去で用途が無い。
    for (const registerFee of [true, 'yes']) {
      window.sessionStorage.setItem(
        STANDARD_INTENT_STORAGE_KEY,
        JSON.stringify({ ...standardIntent(), registerFee }),
      );
      const loaded = loadStandardIntent();
      expect(loaded).toEqual(standardIntent());
      expect(loaded && 'registerFee' in loaded).toBe(false);
    }
  });

  it('注文リンクの支払いの指紋 (orderLinkKey) は params から保存し、復元で params に戻す (第 9 回レビュー G-1)', () => {
    saveStandardPaymentIntent(
      'merchant',
      { ...standardParamsFromIntent(standardIntent()), orderLinkKey: ORDER_LINK_KEY },
      FROM,
      MERCHANT_TX,
      {},
      1_700_000_000_000,
    );

    expect(loadStandardIntent()?.orderLinkKey).toBe(ORDER_LINK_KEY);
    expect(standardParamsFromIntent(loadStandardIntent()!).orderLinkKey).toBe(ORDER_LINK_KEY);
  });

  it('形の崩れた orderLinkKey は落とし、receipt 照会の intent (復旧 latch) は残す', () => {
    saveStandardIntent({ ...standardIntent(), orderLinkKey: 'order-link:raw' as Hex });
    expect(
      window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY),
    ).not.toContain('order-link:raw');

    window.sessionStorage.setItem(
      STANDARD_INTENT_STORAGE_KEY,
      JSON.stringify({ ...standardIntent(), orderLinkKey: 'order-link:raw' }),
    );

    expect(loadStandardIntent()).toEqual(standardIntent());
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

// 売上をほかのウォレットへ移す (plans/store-sales-move.md §2.2): 決済の枠とは別のキー・別の parse。
function salesMoveIntent(): SalesMoveIntentMetadata {
  return {
    version: 1,
    chainId: 80002,
    from: FROM,
    merchant: MERCHANT,
    merchantValue: '5000000000000000000',
    feeValue: '2000000000000000000',
    nonce: NONCE,
    validBefore: '9999999999',
    issuedAt: 1_700_000_000_000,
  };
}

describe('sales move intent sessionStorage', () => {
  it('決済の枠 (openpay:relay-intent:v1) とは別のキーに、公開 metadata だけを保存する', () => {
    expect(SALES_MOVE_INTENT_STORAGE_KEY).toBe('openpay:move-intent:v1');
    expect(SALES_MOVE_INTENT_STORAGE_KEY).not.toBe(RELAY_INTENT_STORAGE_KEY);
    saveSalesMoveIntent({
      ...salesMoveIntent(),
      signature: SIGNATURE,
      payload: { signature: SIGNATURE },
      routeKind: 'recover',
      gasMode: 'customer',
    } as SalesMoveIntentMetadata & { signature: Hex; payload: { signature: Hex }; routeKind: string; gasMode: string });

    const raw = window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(SIGNATURE);
    expect(raw).not.toContain('routeKind');
    expect(raw).not.toContain('gasMode');
    expect(JSON.parse(raw!)).toEqual(salesMoveIntent());
    expect(loadSalesMoveIntent()).toEqual(salesMoveIntent());
    // 決済の枠には書かない (決済の画面が移動を自分の支払いとして読み直さない)。
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
    expect(loadRelayIntent()).toBeNull();

    clearSalesMoveIntent();
    expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('決済の枠を消しても移動の枠は残り、移動の枠を消しても決済の枠は残る', () => {
    saveRelayIntent(relayIntent());
    saveSalesMoveIntent(salesMoveIntent());
    clearRelayIntent();
    expect(loadSalesMoveIntent()).toEqual(salesMoveIntent());
    saveRelayIntent(relayIntent());
    clearSalesMoveIntent();
    expect(loadRelayIntent()).toEqual(relayIntent());
  });

  it.each([
    ['version が無い', { version: undefined }],
    ['version が 2', { version: 2 }],
    ['chainId が文字列', { chainId: '80002' }],
    ['chainId が小数', { chainId: 80002.5 }],
    ['from が崩れている', { from: '0x1234' }],
    ['merchant が崩れている', { merchant: 'shop.eth' }],
    ['merchantValue が 10 進でない', { merchantValue: '1e18' }],
    ['feeValue が負', { feeValue: '-2' }],
    ['nonce が 32 byte でない', { nonce: '0x1234' }],
    ['validBefore が数', { validBefore: 9999999999 }],
    ['issuedAt が 0', { issuedAt: 0 }],
  ] as const)('壊れた値 (%s) は捨てて、枠を空にする', (_name, patch) => {
    window.sessionStorage.setItem(
      SALES_MOVE_INTENT_STORAGE_KEY,
      JSON.stringify({ ...salesMoveIntent(), ...patch }),
    );
    expect(loadSalesMoveIntent()).toBeNull();
    expect(window.sessionStorage.getItem(SALES_MOVE_INTENT_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['JSON でない', '{not json'],
    ['配列', '[]'],
    ['null', 'null'],
  ])('壊れた JSON (%s) は null を返し、throw しない', (_name, raw) => {
    window.sessionStorage.setItem(SALES_MOVE_INTENT_STORAGE_KEY, raw);
    expect(loadSalesMoveIntent()).toBeNull();
  });

  it('決済の枠の形 (version の無い relay intent) は移動の枠として読まない', () => {
    window.sessionStorage.setItem(SALES_MOVE_INTENT_STORAGE_KEY, JSON.stringify(relayIntent()));
    expect(loadSalesMoveIntent()).toBeNull();
  });

  it('旧/将来の追加 field は復元値へ持ち込まない', () => {
    window.sessionStorage.setItem(
      SALES_MOVE_INTENT_STORAGE_KEY,
      JSON.stringify({ ...salesMoveIntent(), signature: SIGNATURE, routeKind: 'recover' }),
    );
    expect(loadSalesMoveIntent()).toEqual(salesMoveIntent());
  });

  it('sessionStorage 障害を save/load/clear から throw しない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveSalesMoveIntent(salesMoveIntent())).not.toThrow();
    vi.restoreAllMocks();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadSalesMoveIntent()).toBeNull();
    vi.restoreAllMocks();

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => clearSalesMoveIntent()).not.toThrow();
  });
});

// 第 10 回レビュー G-1: 署名を求める前に、枠と同じ中身を書いて読み戻せるかを確かめる (売上の移動だけが使う)。
describe('sales move intent: 署名の前の確かめ (canStoreSalesMoveIntent)', () => {
  it('書けて読み戻せる端末では true。枠のキーには書かず、確かめのキーも残さない', () => {
    expect(SALES_MOVE_INTENT_PROBE_KEY).not.toBe(SALES_MOVE_INTENT_STORAGE_KEY);
    const written: [string, string][] = [];
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      written.push([key, value]);
      real.call(this, key, value);
    });
    expect(canStoreSalesMoveIntent(salesMoveIntent())).toBe(true);
    spy.mockRestore();
    // 書いたのは確かめのキーに 1 回・中身は枠と同じ (同じ長さ = 枠が入る余地を確かめている)。
    expect(written).toEqual([[SALES_MOVE_INTENT_PROBE_KEY, JSON.stringify(salesMoveIntent())]]);
    expect(window.sessionStorage.length).toBe(0);
    expect(loadSalesMoveIntent()).toBeNull();
  });

  it('未解決の移動の枠があっても、その枠に触れない', () => {
    saveSalesMoveIntent(salesMoveIntent());
    const other = { ...salesMoveIntent(), nonce: `0x${'9'.repeat(64)}` as Hex };
    expect(canStoreSalesMoveIntent(other)).toBe(true);
    expect(loadSalesMoveIntent()).toEqual(salesMoveIntent());
  });

  it('署名や余分な field は確かめのキーにも書かない', () => {
    const real = Storage.prototype.setItem;
    let raw = '';
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      raw = value;
      real.call(this, key, value);
    });
    expect(
      canStoreSalesMoveIntent({ ...salesMoveIntent(), signature: SIGNATURE } as SalesMoveIntentMetadata & { signature: Hex }),
    ).toBe(true);
    spy.mockRestore();
    expect(raw).not.toContain(SIGNATURE);
    expect(JSON.parse(raw)).toEqual(salesMoveIntent());
  });

  it('書き込みが throw する端末 (容量超過・保存の禁止) では false (throw しない)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(canStoreSalesMoveIntent(salesMoveIntent())).toBe(false);
    spy.mockRestore();
  });

  it('書いたものが読み戻せない端末 (投げずに捨てる・読むと throw) では false', () => {
    const dropped = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(canStoreSalesMoveIntent(salesMoveIntent())).toBe(false);
    dropped.mockRestore();

    const unreadable = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(canStoreSalesMoveIntent(salesMoveIntent())).toBe(false);
    unreadable.mockRestore();
  });

  it('枠として読めない形 (読み戻しても復元できない) は false', () => {
    expect(canStoreSalesMoveIntent({ ...salesMoveIntent(), nonce: '0x1234' as Hex })).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
  });
});
