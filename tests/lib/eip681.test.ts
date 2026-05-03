import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { buildEip681TransferUri, parseEip681Transfer } from '@/lib/eip681';

// JPYC v3 (Polygon mainnet, Sepolia, Avalanche Fuji 同一アドレス) と
// USDC native (Polygon mainnet) を fixture として使う。
const JPYC: Address = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const USDC_BASE: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_POLYGON: Address = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// Vitalik (well-known EIP-55 checksum 適合アドレス)
const TO: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('buildEip681TransferUri', () => {
  it('JPYC (Polygon mainnet, decimals=18) で生成', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: JPYC,
      chainId: 137,
      to: TO,
      amount: '1000',
      decimals: 18,
    });
    expect(uri).toBe(
      `ethereum:${JPYC}@137/transfer?address=${TO}&uint256=1000000000000000000000`,
    );
  });

  it('JPYC (Polygon Amoy, decimals=18) で生成', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: JPYC,
      chainId: 80002,
      to: TO,
      amount: '0.5',
      decimals: 18,
    });
    expect(uri).toBe(
      `ethereum:${JPYC}@80002/transfer?address=${TO}&uint256=500000000000000000`,
    );
  });

  it('USDC (Base mainnet, decimals=6) で生成', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: USDC_BASE,
      chainId: 8453,
      to: TO,
      amount: '10.5',
      decimals: 6,
    });
    expect(uri).toBe(
      `ethereum:${USDC_BASE}@8453/transfer?address=${TO}&uint256=10500000`,
    );
  });

  it('USDC (Polygon mainnet, decimals=6) で生成', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: USDC_POLYGON,
      chainId: 137,
      to: TO,
      amount: '0.01',
      decimals: 6,
    });
    expect(uri).toBe(
      `ethereum:${USDC_POLYGON}@137/transfer?address=${TO}&uint256=10000`,
    );
  });

  it('Arbitrum One (chainId=42161) でも生成できる', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      chainId: 42161,
      to: TO,
      amount: '1',
      decimals: 6,
    });
    expect(uri).toContain('@42161/transfer');
    expect(uri).toContain('uint256=1000000');
  });

  it('入力アドレスが小文字でも EIP-55 checksum 化される', () => {
    const lowerToken = JPYC.toLowerCase() as Address;
    const lowerTo = TO.toLowerCase() as Address;
    const uri = buildEip681TransferUri({
      tokenAddress: lowerToken,
      chainId: 137,
      to: lowerTo,
      amount: '1',
      decimals: 18,
    });
    expect(uri).toContain(JPYC); // checksum 化されたアドレスを含む
    expect(uri).toContain(`address=${TO}`);
  });

  it.each([
    ['不正な token address', { tokenAddress: '0xnotanaddress' as Address }],
    ['不正な receiver address', { to: '0xbadbad' as Address }],
    ['chainId = 0', { chainId: 0 }],
    ['chainId が小数', { chainId: 1.5 }],
    ['chainId が負', { chainId: -1 }],
    ['decimals が負', { decimals: -1 }],
    ['decimals が大きすぎる', { decimals: 100 }],
    ['amount が空文字', { amount: '' }],
    ['amount が非数値', { amount: 'abc' }],
    ['amount = 0', { amount: '0' }],
    ['amount = 0.00', { amount: '0.00' }],
    ['amount の小数桁数 > decimals', { amount: '1.1234567', decimals: 6 }],
  ])('%s で throw', (_label, override) => {
    expect(() =>
      buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 137,
        to: TO,
        amount: '1',
        decimals: 18,
        ...override,
      } as Parameters<typeof buildEip681TransferUri>[0]),
    ).toThrow();
  });
});

describe('parseEip681Transfer', () => {
  it('build したものを parse すると元の値に戻る (JPYC Polygon)', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: JPYC,
      chainId: 137,
      to: TO,
      amount: '1000',
      decimals: 18,
    });
    const parsed = parseEip681Transfer(uri);
    expect(parsed).not.toBeNull();
    expect(parsed!.tokenAddress).toBe(JPYC);
    expect(parsed!.chainId).toBe(137);
    expect(parsed!.to).toBe(TO);
    expect(parsed!.amountWei).toBe(1000000000000000000000n);
  });

  it('build したものを parse すると元の値に戻る (USDC Base)', () => {
    const uri = buildEip681TransferUri({
      tokenAddress: USDC_BASE,
      chainId: 8453,
      to: TO,
      amount: '10.5',
      decimals: 6,
    });
    const parsed = parseEip681Transfer(uri);
    expect(parsed).not.toBeNull();
    expect(parsed!.tokenAddress).toBe(USDC_BASE);
    expect(parsed!.chainId).toBe(8453);
    expect(parsed!.to).toBe(TO);
    expect(parsed!.amountWei).toBe(10500000n);
  });

  it.each([
    ['空文字', ''],
    ['scheme 違い', 'http://example.com'],
    ['scheme 違い 2', `bitcoin:${JPYC}@137/transfer?address=${TO}&uint256=1`],
    ['chain_id 欠落', `ethereum:${JPYC}/transfer?address=${TO}&uint256=1`],
    ['function_name が transfer 以外', `ethereum:${JPYC}@137/approve?address=${TO}&uint256=1`],
    ['function_name 欠落', `ethereum:${JPYC}@137?address=${TO}&uint256=1`],
    ['address query 欠落', `ethereum:${JPYC}@137/transfer?uint256=1`],
    ['uint256 query 欠落', `ethereum:${JPYC}@137/transfer?address=${TO}`],
    ['不正な token address', `ethereum:0xbadbad@137/transfer?address=${TO}&uint256=1`],
    ['不正な receiver address', `ethereum:${JPYC}@137/transfer?address=0xbad&uint256=1`],
    ['不正な chain_id', `ethereum:${JPYC}@abc/transfer?address=${TO}&uint256=1`],
    ['負の chain_id', `ethereum:${JPYC}@-1/transfer?address=${TO}&uint256=1`],
    ['不正な uint256', `ethereum:${JPYC}@137/transfer?address=${TO}&uint256=-1`],
    ['不正な uint256 (alpha)', `ethereum:${JPYC}@137/transfer?address=${TO}&uint256=abc`],
  ])('%s は null を返す', (_label, uri) => {
    expect(parseEip681Transfer(uri)).toBeNull();
  });

  it('non-string 入力は null を返す', () => {
    expect(parseEip681Transfer(undefined as unknown as string)).toBeNull();
    expect(parseEip681Transfer(null as unknown as string)).toBeNull();
    expect(parseEip681Transfer(123 as unknown as string)).toBeNull();
  });
});
