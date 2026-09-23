import { describe, expect, it } from 'vitest';
import { normalizeResourceUrl, resourceUrlClaimKey } from '@/lib/x402/resourceUrlClaim.mjs';
import { parseResourceInput } from '@/lib/x402/registry';

describe('registry claim URL identity', () => {
  it('rejects ambiguous authority syntax at request validation before deriving a claim', () => {
    expect(parseResourceInput({ url: 'https:///example.com/a', description: 'd', priceJpyc: '1', category: 'api' },
      '0x1111111111111111111111111111111111111111')).toEqual({ ok: false, reason: 'invalid_url' });
  });
  it.each([
    ['HTTPS://EXAMPLE.COM:443/a', 'https://example.com/a'],
    ['HTTP://EXAMPLE.COM:80/a', 'http://example.com/a'],
    ['https://EXAMPLE.COM:8443/a', 'https://example.com:8443/a'],
    ['https://[2001:DB8::1]:443/a', 'https://[2001:db8::1]/a'],
    ['https://User:Pass@EXAMPLE.COM/a', 'https://User:Pass@example.com/a'],
    ['https://EXAMPLE.COM', 'https://example.com'],
    ['https://EXAMPLE.COM:/a', 'https://example.com:/a'],
    ['https://EXAMPLE.COM\\Case', 'https://example.com\\Case'],
    ['https://EXAMPLE.COM/A/../b/%2f?Q=a+b&Q=%20#X', 'https://example.com/A/../b/%2f?Q=a+b&Q=%20#X'],
  ])('normalizes only case/default port: %s', (url, expected) => {
    expect(normalizeResourceUrl(url)).toBe(expected);
    expect(normalizeResourceUrl(expected)).toBe(expected);
    expect(resourceUrlClaimKey(url)).toBe(resourceUrlClaimKey(expected));
  });

  it.each([
    ['https://example.com', 'https://example.com/'],
    ['https://example.com/a', 'https://example.com/a/'],
    ['https://example.com/a', 'https://www.example.com/a'],
    ['https://example.com/a', 'https://example.com/A'],
    ['https://example.com/a', 'https://example.com/a?'],
    ['https://example.com/a?b=1&c=2', 'https://example.com/a?c=2&b=1'],
    ['https://example.com/a?q=a+b', 'https://example.com/a?q=a%20b'],
    ['https://example.com/%2f', 'https://example.com/%2F'],
    ['https://example.com/a/../b', 'https://example.com/b'],
  ])('does not merge %s with %s', (a, b) => {
    expect(resourceUrlClaimKey(a)).not.toBe(resourceUrlClaimKey(b));
  });
});
