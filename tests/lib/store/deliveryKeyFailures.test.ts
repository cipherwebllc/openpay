// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '@/tests/fixtures/delivery-ticket.v1.json';
const h = vi.hoisted(() => ({ mode: 'normal' }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, createPublicKey: (...args: Parameters<typeof actual.createPublicKey>) => {
    if (h.mode === 'throw') throw new Error('TEST-ONLY secret must not leak');
    if (h.mode === 'duplicate') return { export: () => ({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }) };
    return actual.createPublicKey(...args);
  } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); h.mode = 'normal'; });
it.each(['throw', 'duplicate'])('derivation %s makes the whole configuration inert without module-init errors or logs', async (mode) => {
  h.mode = mode; vi.stubEnv('STORE_DELIVERY_SIGNING_KEYS', `${fixture.seed},0x${'22'.repeat(32)}`);
  const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error');
  const mod = await import('@/lib/store/deliveryTicket');
  expect(mod.deliveryTicketConfig()).toBeNull(); expect(mod.deliveryJwks()).toEqual({ keys: [] });
  expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
