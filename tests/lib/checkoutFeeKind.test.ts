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

  it('register (レジ) round-trips; feePayer is N/A (always store-borne)', () => {
    const { path, parsed } = roundTrip({ ...base, feeKind: 'register' });
    expect(path).toContain('fee_kind=register');
    expect(path).not.toContain('fee_payer');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBe('register');
      expect(parsed.params.feePayer).toBeUndefined();
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

// 手書き URL / 改竄に対する parse の堅牢性 (strict validation の境界)。
describe('checkout feeKind / feePayer parse edge cases (hand-crafted / tampered URLs)', () => {
  const ITEMS = `${encodeURIComponent('A')}%3A1%3A500`; // A:1:500
  function parseQs(extra: string) {
    return parseCheckoutParams(
      new URLSearchParams(`to=${TO}&token=jpyc&items=${ITEMS}&${extra}`),
    );
  }

  it('orphan fee_payer (no fee_kind) → feePayer undefined (孤立した負担者は無視)', () => {
    const parsed = parseQs('fee_payer=customer');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBeUndefined();
      expect(parsed.params.feePayer).toBeUndefined();
    }
  });

  it("register + fee_payer=customer → feeKind='register' だが feePayer は undefined (register は mobile kind ではない)", () => {
    const parsed = parseQs('fee_kind=register&fee_payer=customer');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBe('register');
      // register は常に店舗負担で feePayer 概念が無い → 手書きされても採用しない。
      expect(parsed.params.feePayer).toBeUndefined();
    }
  });

  it('preorder + invalid fee_payer (bogus) → feePayer undefined (feeKind は保持)', () => {
    const parsed = parseQs('fee_kind=preorder&fee_payer=bogus');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBe('preorder');
      expect(parsed.params.feePayer).toBeUndefined();
    }
  });

  it('storefront + 手書き fee_payer=customer は parse が採用するが downstream で無害 (storefront は常に店舗負担)', () => {
    // build は storefront に fee_payer を出さないが、parse は mobile kind なら受理する非対称。
    // mobileOrderGasMode('storefront', *) は常に 'merchant' なので、この feePayer は inert。
    const parsed = parseQs('fee_kind=storefront&fee_payer=customer');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.params.feeKind).toBe('storefront');
      expect(parsed.params.feePayer).toBe('customer'); // 採用されるが下流で無視される
    }
  });
});
