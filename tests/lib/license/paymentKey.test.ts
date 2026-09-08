import { describe, expect, it } from 'vitest';
import {
  computeLicensePaymentKey,
  computeLicenseTokenId,
} from '@/lib/license/paymentKey';

// contracts/test/OpenPayLicense1155.t.sol と共有する固定値。期待値を helper で再計算しない。
const payment = {
  paymentChainId: 137n,
  paymentToken: '0x1111111111111111111111111111111111111111',
  payer: '0x2222222222222222222222222222222222222222',
  authorizationNonce:
    '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} as const;

describe('computeLicensePaymentKey', () => {
  it.each([
    [137n, '0xd1b175c2ad9cd219287b8a17254555188459c156a1a0174c0025821d6d5ff5e8'],
    [80002n, '0xac1088654c57359a3eceade2018326d23c70d9b278157d419876fd83e8ac420b'],
  ] as const)('matches the Solidity vector for chain %s', (paymentChainId, expected) => {
    expect(computeLicensePaymentKey({ ...payment, paymentChainId })).toBe(expected);
  });

  it('preserves uint256 precision and zero-valued ABI fields', () => {
    expect(computeLicensePaymentKey({
      paymentChainId: 340282366920938463463374607431768211593n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      payer: '0x0000000000000000000000000000000000000000',
      authorizationNonce:
        '0x0000000000000000000000000000000000000000000000000000000000000000',
    })).toBe('0xac66b57dcec1ff2688ea56a7425f1980994439b91968ff6f0f9cd0934e7c9609');
  });

  it('binds token, payer and authorization nonce independently', () => {
    const expected = computeLicensePaymentKey(payment);
    expect(computeLicensePaymentKey({
      ...payment, paymentToken: '0x3333333333333333333333333333333333333333',
    })).not.toBe(expected);
    expect(computeLicensePaymentKey({
      ...payment, payer: '0x3333333333333333333333333333333333333333',
    })).not.toBe(expected);
    expect(computeLicensePaymentKey({
      ...payment,
      authorizationNonce:
        '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdee',
    })).not.toBe(expected);
  });
});

describe('computeLicenseTokenId', () => {
  it.each([
    [
      'h_000102030405060708090a0b0c0d0e0f',
      '0xf1d52e03274f94c6c02c6ef09db2a0408a4962266d56721d5d6cf0bccdbecbb7',
    ],
    [
      'h_ffffffffffffffffffffffffffffffff',
      '0x43cc17a6178e5732517dbbb1ecdeedb06c1379dc9e5250b56ed265c2dd5891cd',
    ],
  ])('matches the Solidity vector for %s', (productId, expected) => {
    expect(computeLicenseTokenId(productId)).toBe(BigInt(expected));
  });

  it('uses the entire product string without normalization', () => {
    const productId = 'h_000102030405060708090a0b0c0d0e0f';
    const expected = computeLicenseTokenId(productId);
    expect(computeLicenseTokenId(productId.slice(2))).not.toBe(expected);
    expect(computeLicenseTokenId(productId.toUpperCase())).not.toBe(expected);
  });
});
