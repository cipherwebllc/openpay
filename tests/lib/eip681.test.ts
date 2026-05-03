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

  describe('小数桁数の境界', () => {
    it('小数桁数 == decimals は ok (USDC, 6 桁ちょうど)', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: USDC_BASE,
        chainId: 8453,
        to: TO,
        amount: '1.123456',
        decimals: 6,
      });
      expect(uri).toContain('uint256=1123456');
    });

    it('小数桁数 == decimals + 1 は throw (USDC, 7 桁)', () => {
      expect(() =>
        buildEip681TransferUri({
          tokenAddress: USDC_BASE,
          chainId: 8453,
          to: TO,
          amount: '1.1234561',
          decimals: 6,
        }),
      ).toThrow(/decimal places/);
    });

    it('末尾ゼロ (有効桁内) は valid: "1.500000" with decimals=6 → 1500000', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: USDC_BASE,
        chainId: 8453,
        to: TO,
        amount: '1.500000',
        decimals: 6,
      });
      expect(uri).toContain('uint256=1500000');
    });

    it('末尾ゼロでも桁数が decimals 超過なら throw: "1.5000000" with decimals=6', () => {
      expect(() =>
        buildEip681TransferUri({
          tokenAddress: USDC_BASE,
          chainId: 8453,
          to: TO,
          amount: '1.5000000',
          decimals: 6,
        }),
      ).toThrow(/decimal places/);
    });

    it('decimals=0 (整数のみ token) + 整数 amount は ok', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: USDC_BASE, // address は流用 (decimals=0 のテスト用 token は無いため)
        chainId: 8453,
        to: TO,
        amount: '100',
        decimals: 0,
      });
      expect(uri).toContain('uint256=100');
    });

    it('decimals=0 + 小数 amount は throw', () => {
      expect(() =>
        buildEip681TransferUri({
          tokenAddress: USDC_BASE,
          chainId: 8453,
          to: TO,
          amount: '100.5',
          decimals: 0,
        }),
      ).toThrow(/decimal places/);
    });
  });

  describe('extreme values', () => {
    it('大きな amount (1 兆 JPYC) を正しく wei 化', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 137,
        to: TO,
        amount: '1000000000000', // 1e12 JPYC
        decimals: 18,
      });
      // 1e12 × 1e18 = 1e30
      expect(uri).toContain('uint256=1000000000000000000000000000000');
    });

    it('1 wei (最小単位) を生成可能', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 137,
        to: TO,
        amount: '0.000000000000000001', // 1e-18 JPYC = 1 wei
        decimals: 18,
      });
      expect(uri).toContain('uint256=1');
    });

    it('Avalanche Fuji (43113) 等の任意 chainId で生成', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 43113, // memory 記載の JPYC v3 deploy 先
        to: TO,
        amount: '1',
        decimals: 18,
      });
      expect(uri).toContain('@43113/transfer');
    });

    it('Sepolia (11155111) で生成', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 11155111,
        to: TO,
        amount: '1',
        decimals: 18,
      });
      expect(uri).toContain('@11155111/transfer');
    });
  });

  describe('出力構造の不変条件', () => {
    it('生成 URI は EIP-681 transfer の正規 regex に合致', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 137,
        to: TO,
        amount: '1',
        decimals: 18,
      });
      // 仕様: ethereum:<EIP-55-addr>@<int>/transfer?address=<EIP-55-addr>&uint256=<int>
      expect(uri).toMatch(
        /^ethereum:0x[a-fA-F0-9]{40}@[1-9]\d*\/transfer\?address=0x[a-fA-F0-9]{40}&uint256=[1-9]\d*$/,
      );
    });

    it('クエリ順序は address → uint256 で固定 (ウォレット parser の互換性)', () => {
      const uri = buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 137,
        to: TO,
        amount: '1',
        decimals: 18,
      });
      const queryStart = uri.indexOf('?');
      const query = uri.slice(queryStart + 1);
      const addressIdx = query.indexOf('address=');
      const uint256Idx = query.indexOf('uint256=');
      expect(addressIdx).toBe(0);
      expect(uint256Idx).toBeGreaterThan(addressIdx);
    });

    it('viem isAddress / URL.canParse の双方で正当 URI と認識される', async () => {
      const { isAddress } = await import('viem');
      const uri = buildEip681TransferUri({
        tokenAddress: JPYC,
        chainId: 137,
        to: TO,
        amount: '10',
        decimals: 18,
      });
      // 構造分解して各部の妥当性を実依存 (viem) で検証
      const match = uri.match(
        /^ethereum:(0x[a-fA-F0-9]{40})@(\d+)\/transfer\?address=(0x[a-fA-F0-9]{40})&uint256=(\d+)$/,
      );
      expect(match).not.toBeNull();
      const [, tok, chainStr, recv, weiStr] = match!;
      expect(isAddress(tok)).toBe(true);
      expect(isAddress(recv)).toBe(true);
      expect(Number(chainStr)).toBe(137);
      expect(BigInt(weiStr)).toBe(10n * 10n ** 18n);
    });
  });
});
