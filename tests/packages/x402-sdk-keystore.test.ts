import { describe, expect, it } from 'vitest';
import {
  createSigner, evaluatePaymentGuards, readRuntimeConfig, readSignerMode,
  redactSensitiveText, REASONS, SIGNER_MODES,
} from 'openpay-x402-sdk';

describe('SDK keystore additions', () => {
  it('accepts an explicit mode and never falls back to an env key', () => {
    expect(SIGNER_MODES.keystore).toBe('keystore');
    expect(readSignerMode({ SIGNER_MODE: 'keystore' })).toBe('keystore');
    expect(() => createSigner({ SIGNER_MODE: 'keystore', BUYER_PRIVATE_KEY: `0x${'1'.repeat(64)}` }))
      .toThrow('keystore keys must be supplied by the caller');
  });

  it.each([
    ['env-key', REASONS.buyerPrivateKeyMissing],
    ['steward', REASONS.stewardSignerUnconfigured],
    ['keystore', REASONS.walletNotInitialized],
  ])('keeps the %s signer guard independent', (mode, reason) => {
    for (const signerAvailable of [false, true]) {
      const guard = evaluatePaymentGuards({
        url: 'https://open-pay.jp/paid', accept: null,
        config: readRuntimeConfig({ SIGNER_MODE: mode }),
        requireSigner: true, signerAvailable,
      });
      expect(guard.reasons.includes(reason)).toBe(mode === 'env-key' || !signerAvailable);
      for (const other of [REASONS.buyerPrivateKeyMissing, REASONS.stewardSignerUnconfigured, REASONS.walletNotInitialized]) {
        if (other !== reason) expect(guard.reasons).not.toContain(other);
      }
    }
  });

  it('redacts 32-byte keys and preserves the existing signature rule and word boundaries', () => {
    const key = `0x${'aB'.repeat(32)}`;
    const signature = `0x${'ab'.repeat(65)}`;
    expect(redactSensitiveText(`${signature} ${key}`)).toBe('[redacted_signature] [redacted_private_key]');
    expect(redactSensitiveText(`${key}a`) === `${key}a`).toBe(true);
  });
});
