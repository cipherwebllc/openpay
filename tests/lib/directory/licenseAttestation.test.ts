import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, zeroAddress, type Hex } from 'viem';
import type { DirectoryLicenseMessage } from '@/lib/directory/licenseAttestation';

const KEY = `0x${'c3'.repeat(32)}` as Hex;
const message: DirectoryLicenseMessage = {
  licensee: zeroAddress,
  licenseId: 'openpay-directory-license-v1',
  contentHash: keccak256(toBytes('[]')),
  rows: 0,
  issuedAt: 1_750_000_000,
};

beforeEach(() => {
  vi.stubEnv('X402_RECEIPT_SIGNING_KEY', KEY);
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

describe('directory license attestation', () => {
  it('hashes the exact JSON items deterministically, including order', async () => {
    const { directoryContentHash } = await import('@/lib/directory/licenseAttestation');
    const items = [{ slug: 'a' }, { slug: 'b' }];
    expect(directoryContentHash(items)).toBe(keccak256(toBytes(JSON.stringify(items))));
    expect(directoryContentHash(JSON.parse(JSON.stringify(items)))).toBe(directoryContentHash(items));
    expect(directoryContentHash([...items].reverse())).not.toBe(directoryContentHash(items));
  });

  it('signs and verifies against the published receipt signer', async () => {
    const { signDirectoryLicense, verifyDirectoryLicense } = await import('@/lib/directory/licenseAttestation');
    const { receiptSignerAddress } = await import('@/lib/x402/receipt');
    const signature = await signDirectoryLicense(message);
    expect(signature).not.toBeNull();
    expect(await verifyDirectoryLicense(message, signature!)).toEqual({ valid: true, signer: receiptSignerAddress() });
    expect((await verifyDirectoryLicense({ ...message, rows: 1 }, signature!)).valid).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const { DIRECTORY_LICENSE_EIP712_DOMAIN, DIRECTORY_LICENSE_TYPES, verifyDirectoryLicense } = await import('@/lib/directory/licenseAttestation');
    const signature = await privateKeyToAccount(`0x${'c4'.repeat(32)}`).signTypedData({
      domain: DIRECTORY_LICENSE_EIP712_DOMAIN,
      types: DIRECTORY_LICENSE_TYPES,
      primaryType: 'DirectoryLicense',
      message: { ...message, rows: BigInt(message.rows), issuedAt: BigInt(message.issuedAt) },
    });
    expect((await verifyDirectoryLicense(message, signature)).valid).toBe(false);
  });

  it('returns null without a signing key and rejects malformed signatures', async () => {
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', '');
    const { signDirectoryLicense, verifyDirectoryLicense } = await import('@/lib/directory/licenseAttestation');
    expect(await signDirectoryLicense(message)).toBeNull();
    expect(await verifyDirectoryLicense(message, '0x')).toEqual({ valid: false, signer: null });
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', KEY);
    vi.resetModules();
    const signed = await import('@/lib/directory/licenseAttestation');
    expect(await signed.verifyDirectoryLicense(message, '0x')).toEqual({ valid: false, signer: null });
  });
});
