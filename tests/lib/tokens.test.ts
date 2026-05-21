import { describe, it, expect, vi, afterEach } from 'vitest';
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
  kaia,
  kairos,
  optimismSepolia,
  polygonAmoy,
} from 'viem/chains';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

// vitest.config.ts で NETWORK_ENV='testnet'。testnet (sepolia 系) deployment を期待。

describe('TOKEN_DEPLOYMENTS', () => {
  it('JPYC は Polygon 1 件のみ (testnet env、Kaia env 未設定の既定状態)', () => {
    // vitest.config.ts の env で NEXT_PUBLIC_JPYC_TESTNET_ADDRESS のみ設定済、
    // KAIROS は未設定。kaia deployment は skip されて出現しない。
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

describe('JPYC Kaia deployment (PoC、env 駆動)', () => {
  it('NEXT_PUBLIC_JPYC_KAIROS_ADDRESS 未設定 → kaia deployment は TOKEN_DEPLOYMENTS に出現しない', () => {
    // 既定 vitest env では KAIROS_ADDRESS は未設定。
    expect(resolveDeployment('jpyc', kairos.id)).toBeUndefined();
    expect(resolveDeployment('jpyc', kaia.id)).toBeUndefined();
    // deploymentsForSymbol('jpyc') は polygon の 1 件のみ
    expect(deploymentsForSymbol('jpyc')).toHaveLength(1);
  });

  it('NEXT_PUBLIC_JPYC_KAIROS_ADDRESS 設定時 → kaia deployment が出現 (testnet=kairos)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS =
      '0xc0de000000000000000000000000000000005555';
    const mod = await import('@/lib/tokens');
    const d = mod.resolveDeployment('jpyc', kairos.id);
    expect(d).toBeDefined();
    expect(d?.symbol).toBe('jpyc');
    expect(d?.chainId).toBe(kairos.id);
    expect(d?.decimals).toBe(18);
    expect(d?.displaySymbol).toBe('JPYC');
    expect(d?.paymasterMode).toBe('sponsorship');
    expect(d?.address.toLowerCase()).toBe(
      '0xc0de000000000000000000000000000000005555',
    );
    // polygon kaia 両方含めて 2 件
    expect(mod.deploymentsForSymbol('jpyc')).toHaveLength(2);
  });

  it('deploymentForSlug("jpyc", "kaia") は env 未設定なら throw (deployment 不在)', () => {
    expect(() => deploymentForSlug('jpyc', 'kaia')).toThrow(
      /No deployment for jpyc on kaia/,
    );
  });

  it('deploymentForSlug("jpyc", "kaia") は env 設定時に kairos deployment を返す', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS =
      '0xc0de000000000000000000000000000000005555';
    const mod = await import('@/lib/tokens');
    const d = mod.deploymentForSlug('jpyc', 'kaia');
    expect(d.chainId).toBe(kairos.id);
    expect(d.address.toLowerCase()).toBe(
      '0xc0de000000000000000000000000000000005555',
    );
  });

  it('mainnet env: KAIA_ADDRESS 設定時に kaia (8217) deployment が出現', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS =
      '0xfeed000000000000000000000000000000006666';
    // mainnet では fee receiver / pimlico / sponsorship policy が必須なので埋める
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xdead000000000000000000000000000000001234';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_test';
    const mod = await import('@/lib/tokens');
    const d = mod.resolveDeployment('jpyc', kaia.id);
    expect(d?.chainId).toBe(kaia.id);
    expect(d?.address.toLowerCase()).toBe(
      '0xfeed000000000000000000000000000000006666',
    );
  });

  it('mainnet env: KAIA_ADDRESS 未設定なら kaia deployment は出現しない (mainnet でも skip)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    delete process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS;
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xdead000000000000000000000000000000001234';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_test';
    const mod = await import('@/lib/tokens');
    expect(mod.resolveDeployment('jpyc', kaia.id)).toBeUndefined();
    // polygon mainnet (137) は default アドレスで必ず deploy 済
    const { polygon: polygonChain } = await import('viem/chains');
    expect(mod.resolveDeployment('jpyc', polygonChain.id)).toBeDefined();
  });
});

describe('USDC は Kaia chain id で resolve しない (型レベル除外の runtime 確認)', () => {
  it('resolveDeployment("usdc", kairos.id) → undefined', () => {
    expect(resolveDeployment('usdc', kairos.id)).toBeUndefined();
  });

  it('resolveDeployment("usdc", kaia.id) → undefined', () => {
    expect(resolveDeployment('usdc', kaia.id)).toBeUndefined();
  });

  it('deploymentsForSymbol("usdc") に kaia chain id は含まれない', () => {
    const chainIds = deploymentsForSymbol('usdc').map((d) => d.chainId);
    expect(chainIds).not.toContain(kaia.id);
    expect(chainIds).not.toContain(kairos.id);
  });
});
