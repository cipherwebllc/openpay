import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('license parent/child flags', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('requires parent %s and child %s on each side', async (parent, child) => {
    vi.stubEnv('ENABLE_CREATOR_STORE', parent ? '1' : '0'); vi.stubEnv('ENABLE_LICENSE_NFT', child ? '1' : '0');
    vi.stubEnv('NEXT_PUBLIC_ENABLE_CREATOR_STORE', parent ? '1' : '0'); vi.stubEnv('NEXT_PUBLIC_ENABLE_LICENSE_NFT', child ? '1' : '0');
    vi.resetModules(); const { env } = await import('@/lib/env'); const { licenseNftEnabled } = await import('@/lib/license/config');
    expect(licenseNftEnabled()).toBe(parent && child); expect(env.enableLicenseNftUi).toBe(parent && child);
  });
  it('keeps the minter key server-only and separate from the relayer', async () => {
    expect(readFileSync('lib/env.ts', 'utf8')).not.toContain('LICENSE_MINTER_PRIVATE_KEY');
    const source = readFileSync('lib/license/minterKey.ts', 'utf8'); expect(source).toContain("import 'server-only'"); expect(source).not.toContain('RELAYER_PRIVATE_KEY');
    const { licenseMinterPrivateKey } = await import('@/lib/license/minterKey');
    vi.stubEnv('LICENSE_MINTER_PRIVATE_KEY', ''); expect(licenseMinterPrivateKey()).toBeNull();
    vi.stubEnv('LICENSE_MINTER_PRIVATE_KEY', '0x' + '0'.repeat(64)); expect(licenseMinterPrivateKey()).toBeNull();
    vi.stubEnv('LICENSE_MINTER_PRIVATE_KEY', '0x' + 'f'.repeat(64)); expect(licenseMinterPrivateKey()).toBeNull();
  });
});
