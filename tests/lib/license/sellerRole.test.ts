import { describe, expect, it, vi } from 'vitest';
import { getAddress, type Address } from 'viem';
import { hostedPurchaseMetadata, type HostedProduct } from '@/lib/x402/hostedStore';
import { sellerRoleFor, withSellerRole } from '@/lib/license/sellerRole';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, feeReceiver: `0x${'ab'.repeat(20)}` } };
});

const operator = getAddress(`0x${'ab'.repeat(20)}`);
const thirdParty = getAddress(`0x${'cd'.repeat(20)}`);

describe('sellerRoleFor', () => {
  it('運営 owner を checksum と小文字のどちらでも同一視する', () => {
    expect(sellerRoleFor(operator)).toBe('operator');
    expect(sellerRoleFor(operator.toLowerCase() as Address)).toBe('operator');
    expect(sellerRoleFor(thirdParty)).toBe('third_party');
  });

  it('受取先や表示名に依存せず、返却時だけ区分を付与する', () => {
    const product: HostedProduct = {
      id: `h_${'a'.repeat(32)}`, owner: operator, payTo: thirdParty,
      title: 'Independent seller', priceJpyc: '1000', contentKind: 'text', label: 'api',
      contentRevision: 1, contentAvailable: true, saleActive: false, createdAt: 1,
      productKind: 'license',
    };
    const displayed = withSellerRole(product);
    expect(displayed.sellerRole).toBe('operator');
    expect(withSellerRole({ ...product, owner: thirdParty, payTo: operator, title: 'OpenPay' }).sellerRole).toBe('third_party');
    expect(product).not.toHaveProperty('sellerRole');
    expect(hostedPurchaseMetadata(displayed)).not.toHaveProperty('sellerRole');
    const digital = { ...product, productKind: undefined };
    expect(withSellerRole(digital)).toBe(digital);
    expect(withSellerRole(digital)).not.toHaveProperty('sellerRole');
  });
});
