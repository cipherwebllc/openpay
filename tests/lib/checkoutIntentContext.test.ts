import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { checkoutIntentContextFingerprint } from '@/lib/checkoutIntentContext';
import type { CheckoutParams } from '@/lib/url';

const MERCHANT =
  '0x2222222222222222222222222222222222222222' as Address;
const TOKEN =
  '0x3333333333333333333333333333333333333333' as Address;

const BASE: CheckoutParams = {
  to: MERCHANT,
  token: 'jpyc',
  chain: 'polygon',
  gas: 'customer',
  mode: 'standard',
  items: [
    {
      name: 'チケット',
      qty: 1,
      price: '3000',
      taxRate: 10,
      taxCategory: 'taxable_10',
      memo: '窓側',
    },
  ],
  orderId: 'order-1',
  description: '店内利用',
  taxRate: 10,
  taxCategory: 'taxable_10',
  receiptNo: 'R-1',
  feeKind: 'storefront',
  feePayer: 'merchant',
  storeHandle: 'alice',
  pickupAt: 1_800_000_000_000,
  webhook: 'https://openpay.example/api/order/notify?h=alice',
  successUrl: 'https://shop.example/thanks',
  cancelUrl: 'https://shop.example/cancel',
  customerEmail: 'payer@example.com',
};

function fingerprint(
  params: CheckoutParams = BASE,
  overrides: {
    chainId?: number;
    tokenAddress?: Address;
    totalAtomic?: string;
  } = {},
) {
  return checkoutIntentContextFingerprint({
    params,
    chainId: overrides.chainId ?? 80002,
    tokenAddress: overrides.tokenAddress ?? TOKEN,
    totalAtomic: overrides.totalAtomic ?? '3000000000000000000000',
  });
}

describe('checkoutIntentContextFingerprint', () => {
  it('同じ公開注文文脈から決定論的な 32-byte digest を返す', () => {
    expect(fingerprint()).toBe(fingerprint({ ...BASE }));
    expect(fingerprint()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  const changes: Array<[string, Partial<CheckoutParams>]> = [
    ['items', { items: [{ name: '別チケット', qty: 1, price: '3000' }] }],
    ['orderId', { orderId: 'order-2' }],
    ['description', { description: '持ち帰り' }],
    ['receiptNo', { receiptNo: 'R-2' }],
    ['feeKind', { feeKind: 'preorder' }],
    ['feePayer', { feePayer: 'customer' }],
    ['storeHandle', { storeHandle: 'bob' }],
    ['pickupAt', { pickupAt: 1_800_000_100_000 }],
  ];
  it.each(changes)('%s が違えば別 digest になる', (_field, changed) => {
    expect(fingerprint({ ...BASE, ...changed })).not.toBe(fingerprint());
  });

  it('chain/token/total の on-chain 文脈が違えば別 digest になる', () => {
    expect(fingerprint(BASE, { chainId: 137 })).not.toBe(fingerprint());
    expect(
      fingerprint(BASE, {
        tokenAddress:
          '0x4444444444444444444444444444444444444444',
      }),
    ).not.toBe(fingerprint());
    expect(fingerprint(BASE, { totalAtomic: '1' })).not.toBe(fingerprint());
  });

  it('callback URL と customerEmail は digest へ含めない', () => {
    expect(
      fingerprint({
        ...BASE,
        webhook: 'https://attacker.example/hook',
        successUrl: 'https://attacker.example/thanks',
        cancelUrl: 'https://attacker.example/cancel',
        customerEmail: 'other@example.com',
      }),
    ).toBe(fingerprint());
  });
});
