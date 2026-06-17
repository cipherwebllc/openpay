import { describe, it, expect } from 'vitest';
import {
  STOREFRONT_FEE_BPS,
  PREORDER_FEE_BPS,
  mobileOrderFeeBps,
  mobileOrderFeeValue,
  mobileOrderGasMode,
  mobileOrderBreakdown,
  isMobileOrderFeeKind,
} from '@/lib/mobileOrderFee';

const ONE = 10n ** 18n; // 1 JPYC (18 decimals) in wei

describe('mobileOrderFee rates', () => {
  it('storefront = 1% (100bps), preorder = 3% (300bps)', () => {
    expect(STOREFRONT_FEE_BPS).toBe(100);
    expect(PREORDER_FEE_BPS).toBe(300);
    expect(mobileOrderFeeBps('storefront')).toBe(100);
    expect(mobileOrderFeeBps('preorder')).toBe(300);
  });

  it('isMobileOrderFeeKind validates strictly', () => {
    expect(isMobileOrderFeeKind('storefront')).toBe(true);
    expect(isMobileOrderFeeKind('preorder')).toBe(true);
    expect(isMobileOrderFeeKind('bogus')).toBe(false);
    expect(isMobileOrderFeeKind('')).toBe(false);
    expect(isMobileOrderFeeKind(undefined)).toBe(false);
    expect(isMobileOrderFeeKind(null)).toBe(false);
    expect(isMobileOrderFeeKind(1)).toBe(false);
  });
});

describe('mobileOrderFeeValue (flat percent, no floor)', () => {
  it('1% of 1000 JPYC = 10 JPYC (storefront)', () => {
    expect(mobileOrderFeeValue(1000n * ONE, 'storefront')).toBe(10n * ONE);
  });

  it('3% of 1000 JPYC = 30 JPYC (preorder)', () => {
    expect(mobileOrderFeeValue(1000n * ONE, 'preorder')).toBe(30n * ONE);
  });

  it('no floor: small orders yield small fees (not bumped to a gas floor)', () => {
    // 1% of 100 JPYC = 1 JPYC (a floor of 2 JPYC would have made this 2)
    expect(mobileOrderFeeValue(100n * ONE, 'storefront')).toBe(1n * ONE);
  });

  it('non-positive order = 0n (never throws)', () => {
    expect(mobileOrderFeeValue(0n, 'storefront')).toBe(0n);
    expect(mobileOrderFeeValue(-5n * ONE, 'preorder')).toBe(0n);
  });

  it('BigInt floor division (truncates, never rounds up)', () => {
    // 1% of 150 wei = 1.5 → floor 1
    expect(mobileOrderFeeValue(150n, 'storefront')).toBe(1n);
    // 3% of 33 wei = 0.99 → floor 0
    expect(mobileOrderFeeValue(33n, 'preorder')).toBe(0n);
  });
});

describe('mobileOrderGasMode (店舗負担 / 顧客上乗せ)', () => {
  it('storefront is always store-borne (merchant), regardless of feePayer', () => {
    expect(mobileOrderGasMode('storefront', 'merchant')).toBe('merchant');
    expect(mobileOrderGasMode('storefront', 'customer')).toBe('merchant');
    expect(mobileOrderGasMode('storefront', undefined)).toBe('merchant');
  });

  it('preorder: merchant = store-borne, customer = surcharge', () => {
    expect(mobileOrderGasMode('preorder', 'merchant')).toBe('merchant');
    expect(mobileOrderGasMode('preorder', 'customer')).toBe('customer');
    // default (undefined) is store-borne
    expect(mobileOrderGasMode('preorder', undefined)).toBe('merchant');
  });
});

describe('mobileOrderBreakdown (path-independent split)', () => {
  const order = 1000n * ONE;

  it('storefront 1% (store-borne): customer pays order, merchant gets 99%, fee = 1%', () => {
    const b = mobileOrderBreakdown(order, 'storefront', 'merchant');
    expect(b.customerPays).toBe(order);
    expect(b.feeAmount).toBe(10n * ONE);
    expect(b.merchantReceives).toBe(990n * ONE);
    // conservation: merchant + fee == customer
    expect(b.merchantReceives + b.feeAmount).toBe(b.customerPays);
  });

  it('preorder 3% store-borne: customer pays order, merchant gets 97%, fee = 3%', () => {
    const b = mobileOrderBreakdown(order, 'preorder', 'merchant');
    expect(b.customerPays).toBe(order);
    expect(b.feeAmount).toBe(30n * ONE);
    expect(b.merchantReceives).toBe(970n * ONE);
    expect(b.merchantReceives + b.feeAmount).toBe(b.customerPays);
  });

  it('preorder 3% customer-added: customer pays order+3%, merchant gets 100%, fee = 3%', () => {
    const b = mobileOrderBreakdown(order, 'preorder', 'customer');
    expect(b.customerPays).toBe(1030n * ONE);
    expect(b.merchantReceives).toBe(order);
    expect(b.feeAmount).toBe(30n * ONE);
    // conservation: merchant + fee == customer
    expect(b.merchantReceives + b.feeAmount).toBe(b.customerPays);
  });

  it('storefront ignores feePayer=customer (still store-borne)', () => {
    const b = mobileOrderBreakdown(order, 'storefront', 'customer');
    expect(b.customerPays).toBe(order);
    expect(b.merchantReceives).toBe(990n * ONE);
  });
});
