// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';
const h = vi.hoisted(() => ({ parent: true, enabled: true }));
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableCreatorStore() { return h.parent; }, get enableStoreDeliveryTicket() { return h.enabled; } } };
});
import { GET, dynamic, runtime } from '@/app/.well-known/openpay-delivery-keys.json/route';
import * as tickets from '@/lib/store/deliveryTicket';
beforeEach(() => { h.parent = true; h.enabled = true; vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', fixture.seed); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it.each([[false, false], [false, true], [true, false]])('JWKS parent %s and flag %s stop before key parsing', async (parent, enabled) => {
  h.parent = parent; h.enabled = enabled; const parser = vi.spyOn(tickets, 'deliveryTicketConfig');
  const response = await GET(); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
  expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(parser).not.toHaveBeenCalled();
});
it.each([undefined, '', fixture.seed + ',', 'invalid'])('unconfigured signer case %# is no-store 404', async (seed) => {
  vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', seed); const response = await GET();
  expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' }); expect(response.headers.get('Cache-Control')).toBe('no-store');
});
it('publishes only Ed25519 public keys with bounded freshness on dynamic node runtime', async () => {
  expect(runtime).toBe('nodejs'); expect(dynamic).toBe('force-dynamic');
  const response = await GET(); expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/json'); expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');
  const text = await response.text(); expect(JSON.parse(text)).toEqual({ keys: [fixture.publicJwk] });
  expect(text).not.toContain('"d":'); expect(text).not.toContain(fixture.seed.slice(2));
});
