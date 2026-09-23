import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = { token: 'usdc', chain: 'arc', payMode: 'gasless', crossChain: true };
// Invoke each hook's real sanitizer without React hydration or storage timing.
vi.mock('@/hooks/useLocalStorageSettings', () => ({
  useLocalStorageSettings: (_key: string, _defaults: unknown, sanitize: (value: unknown) => unknown) => sanitize(saved),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Arc persisted settings', () => {
  it.each(['0', '1'])('flag %s normalizes QR settings', async (flag) => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_ENABLE_USDC_ARC', flag);
    const { useQrSettings } = await import('@/hooks/useQrSettings');
    expect(useQrSettings()).toMatchObject(flag === '1'
      ? { chain: 'arc', payMode: 'standard', crossChain: false }
      : { chain: 'base', payMode: 'gasless', crossChain: true });
  });
});
