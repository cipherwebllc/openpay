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
  it('JPYC は Polygon + Kaia の 2 件 (testnet env、hard-code default で常時 present)', () => {
    // JPYC v3 cross-chain consistency で Kaia mainnet/testnet 同 address を
    // hard-code。env override 無くても deployment は常に 2 件 (polygon + kaia)。
    const jpyc = TOKEN_DEPLOYMENTS.filter((d) => d.symbol === 'jpyc');
    expect(jpyc).toHaveLength(2);
    const chainIds = jpyc.map((d) => d.chainId);
    expect(chainIds).toContain(polygonAmoy.id);
    expect(chainIds).toContain(kairos.id);
    for (const d of jpyc) {
      expect(d.decimals).toBe(18);
      expect(d.displaySymbol).toBe('JPYC');
      expect(d.paymasterMode).toBe('sponsorship');
    }
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
  it('jpyc は 2 件 (polygon + kaia) / usdc は 4 件', () => {
    // 2026-05-23 Kaia 対応で JPYC は polygon + kaia の 2 deployment。
    // USDC は kaia 未対応 (Circle native USDC 未 deploy) で 4 件のまま。
    expect(deploymentsForSymbol('jpyc')).toHaveLength(2);
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

describe('JPYC Kaia deployment (hard-code default + env override)', () => {
  it('env 未設定でも kaia deployment は TOKEN_DEPLOYMENTS に hard-code default で常時 present', () => {
    // JPYC v3 cross-chain consistency で Kaia は mainnet/Polygon と同 address。
    // env override 無くても deployment は出現する (Vercel env 設定漏れに対する
    // safe-by-default、UI で Kaia chooser button が出続ける)。
    const dKairos = resolveDeployment('jpyc', kairos.id);
    expect(dKairos).toBeDefined();
    expect(dKairos?.symbol).toBe('jpyc');
    expect(dKairos?.chainId).toBe(kairos.id);
    expect(dKairos?.decimals).toBe(18);
    expect(dKairos?.displaySymbol).toBe('JPYC');
    expect(dKairos?.paymasterMode).toBe('sponsorship');
    // testnet env では kairos.id が解決される (kaia.id は解決しない)
    expect(resolveDeployment('jpyc', kaia.id)).toBeUndefined();
  });

  it('hard-code default address = 0xE7C3…3c29 (JPYC v3 cross-chain consistency)', () => {
    const d = resolveDeployment('jpyc', kairos.id);
    expect(d?.address.toLowerCase()).toBe(
      '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
    );
  });

  it('deploymentForSlug("jpyc", "kaia") は testnet で kairos を返す (hard-code 経由)', () => {
    const d = deploymentForSlug('jpyc', 'kaia');
    expect(d.chainId).toBe(kairos.id);
    expect(d.address.toLowerCase()).toBe(
      '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
    );
  });

  it('env override 設定時 → hard-code default を上書きする (emergency address 変更用)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS =
      '0xc0de000000000000000000000000000000005555';
    const mod = await import('@/lib/tokens');
    const d = mod.resolveDeployment('jpyc', kairos.id);
    expect(d?.address.toLowerCase()).toBe(
      '0xc0de000000000000000000000000000000005555',
    );
  });

  it('mainnet env: kaia (8217) deployment が hard-code default で present', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    // env override 無し (delete) → hard-code が効くことを確認
    delete process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS;
    // mainnet では fee receiver / pimlico / sponsorship policy が必須なので埋める
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xdead000000000000000000000000000000001234';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_test';
    const mod = await import('@/lib/tokens');
    const d = mod.resolveDeployment('jpyc', kaia.id);
    expect(d?.chainId).toBe(kaia.id);
    expect(d?.address.toLowerCase()).toBe(
      '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29',
    );
  });

  it('mainnet env + KAIA_ADDRESS env override 設定時に hard-code を上書き', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_JPYC_KAIA_ADDRESS =
      '0xfeed000000000000000000000000000000006666';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xdead000000000000000000000000000000001234';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_test';
    const mod = await import('@/lib/tokens');
    const d = mod.resolveDeployment('jpyc', kaia.id);
    expect(d?.address.toLowerCase()).toBe(
      '0xfeed000000000000000000000000000000006666',
    );
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
