import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, zeroAddress, type Hex } from 'viem';
import type { JpycPaymentMessage } from '@/lib/jpyc/paymentAttestation';

const KEY = `0x${'c3'.repeat(32)}` as Hex;
const message: JpycPaymentMessage = {
  licensee: zeroAddress,
  chainId: 137,
  txHash: `0x${'ab'.repeat(32)}`,
  blockNumber: '100',
  transfersHash: keccak256(toBytes('[]')),
  issuedAt: 1_750_000_000,
};

beforeEach(() => {
  vi.stubEnv('X402_RECEIPT_SIGNING_KEY', KEY);
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

describe('JPYC payment attestation', () => {
  it('hashes the exact JSON items deterministically, including order', async () => {
    const { transfersHash } = await import('@/lib/jpyc/paymentAttestation');
    const items = [{ slug: 'a' }, { slug: 'b' }];
    expect(transfersHash(items)).toBe(keccak256(toBytes(JSON.stringify(items))));
    expect(transfersHash(JSON.parse(JSON.stringify(items)))).toBe(transfersHash(items));
    expect(transfersHash([...items].reverse())).not.toBe(transfersHash(items));
  });

  it('signs and verifies against the published receipt signer', async () => {
    const { signJpycPaymentAttestation, verifyJpycPaymentAttestation } = await import('@/lib/jpyc/paymentAttestation');
    const { receiptSignerAddress } = await import('@/lib/x402/receipt');
    const signature = await signJpycPaymentAttestation(message);
    expect(signature).not.toBeNull();
    expect(await verifyJpycPaymentAttestation(message, signature!)).toEqual({ valid: true, signer: receiptSignerAddress() });
    expect((await verifyJpycPaymentAttestation({ ...message, blockNumber: '101' }, signature!)).valid).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const { JPYC_PAYMENT_ATTESTATION_EIP712_DOMAIN, JPYC_PAYMENT_ATTESTATION_TYPES, verifyJpycPaymentAttestation } = await import('@/lib/jpyc/paymentAttestation');
    const signature = await privateKeyToAccount(`0x${'c4'.repeat(32)}`).signTypedData({
      domain: JPYC_PAYMENT_ATTESTATION_EIP712_DOMAIN,
      types: JPYC_PAYMENT_ATTESTATION_TYPES,
      primaryType: 'JpycPayment',
      message: { ...message, chainId: BigInt(message.chainId), blockNumber: BigInt(message.blockNumber), issuedAt: BigInt(message.issuedAt) },
    });
    expect((await verifyJpycPaymentAttestation(message, signature)).valid).toBe(false);
  });

  it('returns null without a signing key and rejects malformed signatures', async () => {
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', '');
    const { signJpycPaymentAttestation, verifyJpycPaymentAttestation } = await import('@/lib/jpyc/paymentAttestation');
    expect(await signJpycPaymentAttestation(message)).toBeNull();
    expect(await verifyJpycPaymentAttestation(message, '0x')).toEqual({ valid: false, signer: null });
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', KEY);
    vi.resetModules();
    const signed = await import('@/lib/jpyc/paymentAttestation');
    expect(await signed.verifyJpycPaymentAttestation(message, '0x')).toEqual({ valid: false, signer: null });
  });
});
