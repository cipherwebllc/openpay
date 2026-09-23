// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { hiddenUrlLedgerKey, normalizeHiddenUrl } from '@/lib/x402/hiddenUrlLedger';
import { resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';

describe('hidden URL moderation identity', () => {
  it.each([
    'https://seller.example/api/x?v=2',
    'https://SELLER.EXAMPLE:443/api/x?v=2#fragment',
    'HTTPS://seller.example/api/x?other=1&v=3',
    'https://seller.example/api/x#fragment',
    'https://user:password@seller.example/api/x?v=2',
  ])('uses only normalized origin and path: %s', (url) => {
    expect(normalizeHiddenUrl(url)).toBe('https://seller.example/api/x');
    expect(hiddenUrlLedgerKey(url)).toBe(hiddenUrlLedgerKey('https://seller.example/api/x?v=1'));
  });

  it('normalizes the HTTP default port independently of HTTPS', () => {
    expect(normalizeHiddenUrl('HTTP://SELLER.EXAMPLE:80/api/x?v=2#fragment'))
      .toBe('http://seller.example/api/x');
  });

  it.each([
    'http://seller.example/api/x',
    'https://seller.example:8443/api/x',
    'https://other.example/api/x',
    'https://www.seller.example/api/x',
    'https://seller.example/api/other',
    'https://seller.example/api/x/',
    'https://seller.example/API/x',
  ])('keeps distinct schemes, hosts, non-default ports and paths separate: %s', (url) => {
    expect(hiddenUrlLedgerKey(url)).not.toBe(hiddenUrlLedgerKey('https://seller.example/api/x'));
  });

  it('keeps query variants distinct in the URL claim index', () => {
    const original = 'https://seller.example/api/x?v=1';
    const variant = 'https://seller.example/api/x?v=2';
    expect(hiddenUrlLedgerKey(original)).toBe(hiddenUrlLedgerKey(variant));
    expect(resourceUrlClaimKey(original)).not.toBe(resourceUrlClaimKey(variant));
  });
});
