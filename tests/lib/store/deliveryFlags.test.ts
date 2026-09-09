import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each([[false, false], [false, true], [true, false], [true, true]])('delivery flags require parent=%s and child=%s independently', async (parent, child) => {
  vi.stubEnv('ENABLE_CREATOR_STORE', parent ? '1' : '0'); vi.stubEnv('ENABLE_STORE_DELIVERY_TICKET', child ? 'true' : '0');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_CREATOR_STORE', parent ? 'true' : '0'); vi.stubEnv('NEXT_PUBLIC_ENABLE_STORE_DELIVERY_TICKET', child ? '1' : '0');
  vi.resetModules(); const { env } = await import('@/lib/env');
  expect(env.enableStoreDeliveryTicket).toBe(parent && child); expect(env.enableStoreDeliveryTicketUi).toBe(parent && child);
});
it('all absent means OFF and a public child cannot turn on the server', async () => {
  for (const name of ['ENABLE_CREATOR_STORE', 'ENABLE_STORE_DELIVERY_TICKET', 'NEXT_PUBLIC_ENABLE_CREATOR_STORE', 'NEXT_PUBLIC_ENABLE_STORE_DELIVERY_TICKET']) vi.stubEnv(name, undefined);
  vi.resetModules(); let { env } = await import('@/lib/env'); expect(env.enableStoreDeliveryTicket).toBe(false); expect(env.enableStoreDeliveryTicketUi).toBe(false);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_CREATOR_STORE', '1'); vi.stubEnv('NEXT_PUBLIC_ENABLE_STORE_DELIVERY_TICKET', '1');
  vi.resetModules(); ({ env } = await import('@/lib/env')); expect(env.enableStoreDeliveryTicket).toBe(false); expect(env.enableStoreDeliveryTicketUi).toBe(true);
});
