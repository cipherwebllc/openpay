import { describe, expect, it } from 'vitest';
import {
  legacyBillingPaymentKey,
  parsePaymentClaimKind,
  paymentClaimKey,
  paymentClaimPendingValue,
  paymentClaimResultValue,
} from '@/lib/paymentClaim';

describe('paymentClaim', () => {
  it('chainId×lowercase txHash を全 payment 用途で共有する', () => {
    const hash = `0x${'A'.repeat(64)}`;
    expect(paymentClaimKey(137, hash)).toBe(
      `payment:claimed:137:0x${'a'.repeat(64)}`,
    );
    expect(legacyBillingPaymentKey(137, hash)).toBe(
      `billing:settled:137:0x${'a'.repeat(64)}`,
    );
  });

  it('既存 Pro/CSV pending/result の production value を維持する', () => {
    expect(paymentClaimPendingValue('pro', 'owner')).toBe(
      'p:{"tier":"pro","owner":"owner"}',
    );
    expect(paymentClaimResultValue('pro')).toBe('r:pro');
    expect(paymentClaimResultValue('csvpass')).toBe('r:csvpass');
  });

  it.each([
    ['r:pro', 'pro'],
    ['r:csvpass', 'csvpass'],
    ['r:order', 'order'],
    ['r:register:0xabc', 'register'],
    ['r:billing:0xabc:2026-06', 'billing'],
    ['p:{"tier":"order","owner":"x"}', 'order'],
  ] as const)('%s の用途を復元', (value, kind) => {
    expect(parsePaymentClaimKind(value)).toBe(kind);
  });
});
