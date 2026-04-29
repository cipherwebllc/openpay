import { describe, it, expect } from 'vitest';
import {
  defaultDeploymentForSymbol,
  deploymentForSlug,
  deploymentsForSymbol,
  isValidTokenSymbol,
  resolveDeployment,
  TOKEN_DEPLOYMENTS,
  DEFAULT_CHAIN_FOR_SYMBOL,
} from '@/lib/tokens';
import {
  arbitrumSepolia,
  baseSepolia,
  optimismSepolia,
  polygonAmoy,
} from 'viem/chains';

// vitest.config.ts で NETWORK_ENV='testnet'。testnet (sepolia 系) deployment を期待。

describe('TOKEN_DEPLOYMENTS', () => {
  it('JPYC は Polygon 1 件のみ', () => {
    const jpyc = TOKEN_DEPLOYMENTS.filter((d) => d.symbol === 'jpyc');
    expect(jpyc).toHaveLength(1);
    expect(jpyc[0].chainId).toBe(polygonAmoy.id);
    expect(jpyc[0].decimals).toBe(18);
    expect(jpyc[0].displaySymbol).toBe('JPYC');
    expect(jpyc[0].paymasterMode).toBe('sponsorship');
  });

  it('USDC は 4 chain (Base / Arbitrum / Optimism / Polygon)', () => {
    const usdc = TOKEN_DEPLOYMENTS.filter((d) => d.symbol === 'usdc');
    expect(usdc).toHaveLength(4);
    const chainIds = usdc.map((d) => d.chainId);
    expect(chainIds).toContain(baseSepolia.id);
    expect(chainIds).toContain(arbitrumSepolia.id);
    expect(chainIds).toContain(optimismSepolia.id);
    expect(chainIds).toContain(polygonAmoy.id);
    for (const d of usdc) {
      expect(d.decimals).toBe(6);
      expect(d.displaySymbol).toBe('USDC');
      expect(d.paymasterMode).toBe('erc20');
    }
  });

  it('(symbol, chainId) ペアは一意', () => {
    const seen = new Set<string>();
    for (const d of TOKEN_DEPLOYMENTS) {
      const key = `${d.symbol}:${d.chainId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('testnet で env override (NEXT_PUBLIC_JPYC_TESTNET_ADDRESS) が効く', () => {
    const jpyc = TOKEN_DEPLOYMENTS.find((d) => d.symbol === 'jpyc')!;
    expect(jpyc.address.toLowerCase()).toBe(
      '0x0000000000000000000000000000000000000abc',
    );
  });

  it('Base Sepolia の USDC は Circle 公式アドレスがフォールバック', () => {
    const d = resolveDeployment('usdc', baseSepolia.id)!;
    expect(d.address.toLowerCase()).toBe(
      '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    );
  });
});

describe('DEFAULT_CHAIN_FOR_SYMBOL', () => {
  it('jpyc → polygon, usdc → base', () => {
    expect(DEFAULT_CHAIN_FOR_SYMBOL.jpyc).toBe('polygon');
    expect(DEFAULT_CHAIN_FOR_SYMBOL.usdc).toBe('base');
  });
});

describe('resolveDeployment', () => {
  it('対応する (symbol, chainId) では deployment を返す', () => {
    expect(resolveDeployment('usdc', baseSepolia.id)?.symbol).toBe('usdc');
    expect(resolveDeployment('jpyc', polygonAmoy.id)?.symbol).toBe('jpyc');
  });

  it('未対応の組合せ (jpyc + arbitrum) は undefined', () => {
    expect(resolveDeployment('jpyc', arbitrumSepolia.id)).toBeUndefined();
  });

  it('未知 chainId は undefined', () => {
    expect(resolveDeployment('usdc', 999_999)).toBeUndefined();
  });
});

describe('deploymentsForSymbol', () => {
  it('jpyc は 1 件 / usdc は 4 件', () => {
    expect(deploymentsForSymbol('jpyc')).toHaveLength(1);
    expect(deploymentsForSymbol('usdc')).toHaveLength(4);
  });
});

describe('deploymentForSlug', () => {
  it('(usdc, base) → Base Sepolia (testnet env)', () => {
    const d = deploymentForSlug('usdc', 'base');
    expect(d.symbol).toBe('usdc');
    expect(d.chainId).toBe(baseSepolia.id);
  });

  it('(usdc, arbitrum) → Arbitrum Sepolia', () => {
    const d = deploymentForSlug('usdc', 'arbitrum');
    expect(d.chainId).toBe(arbitrumSepolia.id);
  });

  it('(jpyc, polygon) → Polygon Amoy', () => {
    const d = deploymentForSlug('jpyc', 'polygon');
    expect(d.chainId).toBe(polygonAmoy.id);
  });

  it('(jpyc, arbitrum) は throw (deployment 不在)', () => {
    expect(() => deploymentForSlug('jpyc', 'arbitrum')).toThrow();
  });
});

describe('defaultDeploymentForSymbol', () => {
  it('usdc → Base Sepolia (testnet)', () => {
    const d = defaultDeploymentForSymbol('usdc');
    expect(d.chainId).toBe(baseSepolia.id);
  });

  it('jpyc → Polygon Amoy (testnet)', () => {
    const d = defaultDeploymentForSymbol('jpyc');
    expect(d.chainId).toBe(polygonAmoy.id);
  });
});

describe('isValidTokenSymbol', () => {
  it.each(['jpyc', 'usdc'])('"%s" → true', (s) => {
    expect(isValidTokenSymbol(s)).toBe(true);
  });

  it.each(['eth', 'JPYC', '', 'btc', 'usdt'])('"%s" → false', (s) => {
    expect(isValidTokenSymbol(s)).toBe(false);
  });
});
