import { describe, it, expect } from 'vitest';
import {
  buildCheckoutPath,
  parseCheckoutParams,
  type CheckoutParams,
} from '@/lib/url/checkout';
import type { Address } from 'viem';

const TO = '0x1111111111111111111111111111111111111111' as Address;

const base: CheckoutParams = {
  to: TO,
  token: 'jpyc',
  gas: 'customer',
  items: [{ name: 'コーヒー', qty: 1, price: '500' }],
};

function roundTrip(params: CheckoutParams) {
  const path = buildCheckoutPath(params);
  const qs = path.split('?')[1] ?? '';
  return { path, parsed: parseCheckoutParams(new URLSearchParams(qs)) };
}

describe('checkout feeKind / feePayer round-trip', () => {
  it('omitted by default → backward compatible (no fee_kind / fee_payer in URL)', () => {
    const { path, parsed } = roundTrip(base);
    expect(path).not.toContain('fee_kind');
    expect(path).not.toContain('fee_payer');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBeUndefined();
      expect(parsed.params.feePayer).toBeUndefined();
    }
  });

  it('storefront: feeKind serialized; feePayer omitted (storefront is always store-borne)', () => {
    const { path, parsed } = roundTrip({
      ...base,
      feeKind: 'storefront',
      feePayer: 'merchant',
    });
    expect(path).toContain('fee_kind=storefront');
    expect(path).not.toContain('fee_payer');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBe('storefront');
      expect(parsed.params.feePayer).toBeUndefined();
    }
  });

  it('preorder + customer (顧客上乗せ) round-trips both fields', () => {
    const { path, parsed } = roundTrip({
      ...base,
      feeKind: 'preorder',
      feePayer: 'customer',
    });
    expect(path).toContain('fee_kind=preorder');
    expect(path).toContain('fee_payer=customer');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBe('preorder');
      expect(parsed.params.feePayer).toBe('customer');
    }
  });

  it('preorder + merchant (店舗負担) round-trips faithfully (fee_payer serialized for preorder)', () => {
    const { path, parsed } = roundTrip({
      ...base,
      feeKind: 'preorder',
      feePayer: 'merchant',
    });
    expect(path).toContain('fee_kind=preorder');
    // feePayer is serialized for preorder (both values) so the bearer is unambiguous on round-trip.
    expect(path).toContain('fee_payer=merchant');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBe('preorder');
      expect(parsed.params.feePayer).toBe('merchant');
    }
  });

  it('invalid fee_kind is ignored (strict validation → undefined)', () => {
    const parsed = parseCheckoutParams(
      new URLSearchParams(
        `to=${TO}&token=jpyc&items=${encodeURIComponent('A')}%3A1%3A500&fee_kind=bogus&fee_payer=customer`,
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBeUndefined();
      // feePayer is only adopted when a valid feeKind is present
      expect(parsed.params.feePayer).toBeUndefined();
    }
  });
});
