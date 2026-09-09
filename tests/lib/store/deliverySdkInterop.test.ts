// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryGate, verifyDeliveryTicket } from 'openpay-x402-sdk/delivery';
import { deliveryJwks, signDeliveryTicket } from '@/lib/store/deliveryTicket';
import { parseDeliveryUrl } from '@/lib/store/deliveryUrl';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';

beforeEach(() => vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', fixture.seed));
afterEach(() => vi.unstubAllEnvs());

describe('fresh server signatures interoperate with the published SDK delivery subpath', () => {
  it.each(['purchase', 'holder'] as const)('agrees on fresh %s tickets, normalized audience and every returned field', async (basis) => {
    const now = Math.floor(Date.now() / 1000);
    const destination = parseDeliveryUrl('https://FILES.example:443/download');
    expect(destination.ok).toBe(true);
    if (!destination.ok) throw new Error('invalid test destination');
    const signed = signDeliveryTicket({ audience: destination.origin, subject: fixture.claims.sub,
      product: fixture.claims.product, revision: basis === 'holder' ? 1 : 7, basis, now });
    expect(signed).not.toBeNull(); expect(signed).not.toBe(fixture.ticket);
    const keys = deliveryJwks().keys;
    const fetch = vi.fn(() => { throw new Error('Direct keys must never fetch'); });
    const options = { product: fixture.claims.product, audience: 'https://FILES.example:443/', keys, now: () => now * 1000, fetch };
    const verified = await verifyDeliveryTicket({ ...options, ticket: signed! });
    expect(verified).toEqual({ address: fixture.claims.sub, product: fixture.claims.product,
      revision: basis === 'holder' ? 1 : 7, basis, exp: now + 60, iat: now,
      jti: expect.stringMatching(/^[0-9a-f]{32}$/), kid: fixture.publicJwk.kid });
    const gate = createDeliveryGate(options); await gate.ready();
    expect(await gate.verifyRequest(new Request(`https://files.example/download?ticket=${signed}`))).toEqual(verified);
    expect(fetch).not.toHaveBeenCalled();
    await expect(verifyDeliveryTicket({ ...options, ticket: signed!, audience: 'https://other.example' })).rejects.toMatchObject({ code: 'wrong_audience' });
    await expect(verifyDeliveryTicket({ ...options, ticket: signed!, issuer: 'https://other.example' })).rejects.toMatchObject({ code: 'wrong_issuer' });
  });

  it('accepts staged publish-before-sign rotation and rejects retired keys', async () => {
    const nextSeed = '0x' + '22'.repeat(32);
    const now = Math.floor(Date.now() / 1000);
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', `${fixture.seed},${nextSeed}`);
    const published = deliveryJwks().keys;
    vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', `${nextSeed},${fixture.seed}`);
    const signed = signDeliveryTicket({ audience: fixture.claims.aud, subject: fixture.claims.sub,
      product: fixture.claims.product, revision: 1, basis: 'purchase', now })!;
    const input = { audience: fixture.claims.aud, product: fixture.claims.product, ticket: signed, now: () => now * 1000 };
    expect((await verifyDeliveryTicket({ ...input, keys: published })).kid).toBe(published[1].kid);
    await expect(verifyDeliveryTicket({ ...input, keys: [published[0]] })).rejects.toMatchObject({ code: 'unknown_key' });
  });
});
