import { describe, it, expect } from 'vitest';
import { getAddress, parseUnits } from 'viem';
import {
  storefrontDiscountWei,
  validStorefrontDiscount,
  STOREFRONT_DISCOUNT_AMOUNT_MAX,
} from '@/lib/mobileOrderDiscount';
import {
  decodeOrderConfig,
  encodeOrderConfig,
  storefrontPartsEquivalent,
  validateStorefrontParts,
} from '@/lib/mobileOrder';
import { handleStorefrontConfig, type HandleRecord } from '@/lib/handle';

// モバイル注文の店舗の値引き (plans/discount-common.md PR3)。公開した storefront が正本。

const J = (v: string) => parseUnits(v, 18);
const ADDR = getAddress('0x1234567890123456789012345678901234567890');

describe('validStorefrontDiscount (店舗設定の検証と正規化)', () => {
  it.each([
    [{ kind: 'percent', value: '5' }, { kind: 'percent', value: '5' }],
    [{ kind: 'percent', value: '05' }, { kind: 'percent', value: '5' }],
    [{ kind: 'percent', value: '2.50' }, { kind: 'percent', value: '2.5' }],
    [{ kind: 'percent', value: '0.01' }, { kind: 'percent', value: '0.01' }],
    [{ kind: 'percent', value: '99.99' }, { kind: 'percent', value: '99.99' }],
    [{ kind: 'amount', value: '50' }, { kind: 'amount', value: '50' }],
    [{ kind: 'amount', value: '050' }, { kind: 'amount', value: '50' }],
  ])('%j → %j', (raw, expected) => {
    expect(validStorefrontDiscount(raw)).toEqual(expected);
  });

  it.each([
    null,
    'percent',
    { kind: 'percent', value: 5 }, // number は受けない (率の切り捨てが client / server でぶれない文字列だけ)
    { kind: 'percent', value: '0' },
    { kind: 'percent', value: '100' },
    { kind: 'percent', value: '2.555' },
    { kind: 'percent', value: '-1' },
    { kind: 'amount', value: '0' },
    { kind: 'amount', value: '1.5' },
    { kind: 'amount', value: String(STOREFRONT_DISCOUNT_AMOUNT_MAX + 1) },
    { kind: 'coupon', value: '5' },
  ])('不正 (%j) は null (= 値引きなし)', (raw) => {
    expect(validStorefrontDiscount(raw)).toBeNull();
  });
});

describe('storefrontDiscountWei (小計に当てる)', () => {
  it('率は円未満切り捨て (1,234 の 5% = 61.7 → 61)', () => {
    expect(storefrontDiscountWei({ kind: 'percent', value: '5' }, J('1234'), 18)).toBe(J('61'));
  });
  it('額は小計を下回るときだけ (支払額が 1 円以上残る)', () => {
    const rule = { kind: 'amount', value: '100' } as const;
    expect(storefrontDiscountWei(rule, J('101'), 18)).toBe(J('100'));
    expect(storefrontDiscountWei(rule, J('100'), 18)).toBe(0n);
    expect(storefrontDiscountWei(rule, J('50'), 18)).toBe(0n);
  });
  it('値引きなし・小計 0・切り捨てて 0 になる率は 0', () => {
    expect(storefrontDiscountWei(undefined, J('1000'), 18)).toBe(0n);
    expect(storefrontDiscountWei({ kind: 'percent', value: '5' }, 0n, 18)).toBe(0n);
    expect(storefrontDiscountWei({ kind: 'percent', value: '1' }, J('50'), 18)).toBe(0n);
  });
});

describe('店舗設定 (storefront) と公開ページの config', () => {
  const parts = {
    chain: 'polygon',
    mode: 'storefront',
    feePayer: 'merchant',
    menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
  };

  it('公開設定は値引きを保持し、壊れた値引きは捨てる (注文は壊さない)', () => {
    expect(validateStorefrontParts({ ...parts, discount: { kind: 'percent', value: '5' } })?.discount).toEqual({
      kind: 'percent',
      value: '5',
    });
    const broken = validateStorefrontParts({ ...parts, discount: { kind: 'percent', value: '150' } });
    expect(broken).not.toBeNull();
    expect(broken?.discount).toBeUndefined();
  });

  it('値引きを変えたら未公開の変更として扱う (公開済みとの比較)', () => {
    expect(
      storefrontPartsEquivalent(
        { ...parts, discount: { kind: 'percent', value: '5' } },
        { ...parts, discount: { kind: 'percent', value: '05' } },
      ),
    ).toBe(true);
    expect(storefrontPartsEquivalent({ ...parts, discount: { kind: 'percent', value: '5' } }, parts)).toBe(false);
  });

  it('@handle の公開ページの config には値引きを載せる', () => {
    const record: HandleRecord = {
      owner: ADDR,
      config: { to: ADDR, name: '珈琲店', methods: [{ token: 'jpyc', chain: 'polygon' }] },
      storefront: {
        chain: 'polygon',
        mode: 'storefront',
        feePayer: 'merchant',
        menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
        discount: { kind: 'amount', value: '50' },
      },
      createdAt: 1,
      updatedAt: 2,
    };
    expect(handleStorefrontConfig(record, 'shop')?.discount).toEqual({ kind: 'amount', value: '50' });
  });

  it('?s= の自己完結 URL には正本が無いので値引きを載せない', () => {
    const token = encodeOrderConfig({
      receiver: ADDR,
      chain: 'polygon',
      shopName: '珈琲店',
      mode: 'storefront',
      feePayer: 'merchant',
      socials: [],
      menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
      discount: { kind: 'percent', value: '50' },
    });
    const config = decodeOrderConfig(token);
    expect(config).not.toBeNull();
    expect(config?.discount).toBeUndefined();
  });
});
