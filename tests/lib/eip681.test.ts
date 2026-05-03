import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { buildEip681TransferUri } from '@/lib/eip681';

const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_ARBITRUM: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
// Vitalik (well-known EIP-55 checksum 適合)
const TO: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('buildEip681TransferUri', () => {
  it.each([
    {
      label: 'JPYC Polygon mainnet (decimals=18, 整数 amount)',
      input: { tokenAddress: JPYC, chainId: 137, to: TO, amount: '1000', decimals: 18 },
      expected: `ethereum:${JPYC}@137/transfer?address=${TO}&uint256=1000000000000000000000`,
    },
    {
      label: 'JPYC Polygon Amoy (decimals=18, 小数 amount)',
      input: { tokenAddress: JPYC, chainId: 80002, to: TO, amount: '0.5', decimals: 18 },
      expected: `ethereum:${JPYC}@80002/transfer?address=${TO}&uint256=500000000000000000`,
    },
    {
      label: 'USDC Base mainnet (decimals=6)',
      input: { tokenAddress: USDC_BASE, chainId: 8453, to: TO, amount: '10.5', decimals: 6 },
      expected: `ethereum:${USDC_BASE}@8453/transfer?address=${TO}&uint256=10500000`,
    },
    {
      label: 'USDC Arbitrum One (decimals=6, 最小単位 amount)',
      input: { tokenAddress: USDC_ARBITRUM, chainId: 42161, to: TO, amount: '0.000001', decimals: 6 },
      expected: `ethereum:${USDC_ARBITRUM}@42161/transfer?address=${TO}&uint256=1`,
    },
  ])('$label を生成', ({ input, expected }) => {
    expect(buildEip681TransferUri(input)).toBe(expected);
  });

  it('小文字アドレス入力は EIP-55 checksum 化される', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: JPYC.toLowerCase() as Address,
      chainId: 137,
      to: TO.toLowerCase() as Address,
      amount: '1',
      decimals: 18,
    });
    expect(uri).toContain(JPYC);
    expect(uri).toContain(`address=${TO}`);
  });

  it('小数桁数 > decimals は throw (parseUnits の silent round を防ぐ)', () => {
    expect(() =>
      buildEip681TransferUri({
        tokenAddress: USDC_BASE,
        chainId: 8453,
        to: TO,
        amount: '1.1234567',
        decimals: 6,
      }),
    ).toThrow(/decimal places/);
  });
});
