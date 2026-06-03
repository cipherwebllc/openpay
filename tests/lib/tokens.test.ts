import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  defaultDeploymentForSymbol,
  deploymentForSlug,
  deploymentsForSymbol,
  isValidTokenSymbol,
  resolveDeployment,
  TOKEN_DEPLOYMENTS,
  DEFAULT_CHAIN_FOR_SYMBOL,
  counterpartSymbol,
  displaySymbolFor,
  symbolHasDeployment,
  defaultConvertChainSlug,
} from '@/lib/tokens';
import {
  arbitrumSepolia,
  avalancheFuji,
  baseSepolia,
  kaia,
  kairos,
  mainnet,
  optimismSepolia,
  polygonAmoy,
  sepolia,
  unichainSepolia,
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

  it('USDC は 11 chain (merchant 6 + buyer-only 5: Base / Arbitrum / Optimism / Polygon / Ethereum / Avalanche + Unichain / World Chain / Sonic / Sei / HyperEVM)', () => {
    const usdc = TOKEN_DEPLOYMENTS.filter((d) => d.symbol === 'usdc');
    expect(usdc).toHaveLength(11);
    const chainIds = usdc.map((d) => d.chainId);
    // merchant chain (6, phase 4b-2 で Avalanche 昇格)
    expect(chainIds).toContain(baseSepolia.id);
    expect(chainIds).toContain(arbitrumSepolia.id);
    expect(chainIds).toContain(optimismSepolia.id);
    expect(chainIds).toContain(polygonAmoy.id);
    expect(chainIds).toContain(sepolia.id);
    expect(chainIds).toContain(avalancheFuji.id);
    // buyer-only chain (1, Unichain)
    expect(chainIds).toContain(unichainSepolia.id);
    // buyer-only chain (4, phase 4b-3)
    expect(chainIds).toContain(4801); // worldchainSepolia
    expect(chainIds).toContain(57054); // sonicBlazeTestnet
    expect(chainIds).toContain(1328); // seiTestnet
    expect(chainIds).toContain(998); // hyperEvmTestnet (inline-defined)
    for (const d of usdc) {
      expect(d.decimals).toBe(6);
      expect(d.displaySymbol).toBe('USDC');
    }
    // buyer-only 5 chain (Unichain / World / Sonic / Sei / HyperEVM) のみ
    // paymasterMode='unavailable' (gasless 不要)、merchant 受信 chain 6 件
    // (Ethereum / Avalanche 含む) は全て erc20 で gasless 可能。
    const unavailableChainIds = new Set<number>([
      unichainSepolia.id,
      4801,
      57054,
      1328,
      998,
    ]);
    for (const d of usdc) {
      if (unavailableChainIds.has(d.chainId)) {
        expect(d.paymasterMode).toBe('unavailable');
      } else {
        expect(d.paymasterMode).toBe('erc20');
      }
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
  it('jpyc は 2 件 (polygon + kaia) / usdc は 11 件 (merchant 6 + buyer-only 5)', () => {
    // 2026-05-23 Kaia 対応で JPYC は polygon + kaia の 2 deployment。
    // USDC は kaia 未対応 (Circle native USDC 未 deploy)、phase 4a で Ethereum L1
    // 追加、phase 4b-1 で Avalanche / Unichain buyer-only 追加、
    // phase 4b-2 で Avalanche を merchant 昇格 (merchant 6 + buyer-only 1)、
    // phase 4b-3 で World Chain / Sonic / Sei / HyperEVM 計 4 chain を buyer-only として
    // 追加 (合計 merchant 6 + buyer-only 5)。
    expect(deploymentsForSymbol('jpyc')).toHaveLength(2);
    expect(deploymentsForSymbol('usdc')).toHaveLength(11);
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

describe('Ethereum L1 USDC deployment (phase 4a)', () => {
  it('testnet env: Sepolia USDC (paymasterMode=erc20)', () => {
    const d = resolveDeployment('usdc', sepolia.id);
    expect(d).toBeDefined();
    expect(d?.symbol).toBe('usdc');
    expect(d?.chainId).toBe(sepolia.id);
    expect(d?.decimals).toBe(6);
    expect(d?.paymasterMode).toBe('erc20');
    // Sepolia 公式 USDC (Circle quickstart)
    expect(d?.address.toLowerCase()).toBe(
      '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    );
  });

  it('mainnet env: Ethereum L1 USDC (paymasterMode=erc20)', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_ENV = 'mainnet';
    process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS =
      '0xdead000000000000000000000000000000001234';
    process.env.NEXT_PUBLIC_PIMLICO_API_KEY = 'test_pimlico_key';
    process.env.NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID = 'sp_test';
    const mod = await import('@/lib/tokens');
    const d = mod.resolveDeployment('usdc', mainnet.id);
    expect(d?.chainId).toBe(mainnet.id);
    expect(d?.paymasterMode).toBe('erc20');
    expect(d?.address.toLowerCase()).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    );
  });

  it('deploymentForSlug("usdc", "ethereum") は testnet で Sepolia を返す', () => {
    const d = deploymentForSlug('usdc', 'ethereum');
    expect(d.chainId).toBe(sepolia.id);
    expect(d.paymasterMode).toBe('erc20');
  });
});

describe('isGaslessSupported', () => {
  it('USDC on ethereum は true (Pimlico ERC20 paymaster 対応)', async () => {
    const mod = await import('@/lib/tokens');
    const d = mod.deploymentForSlug('usdc', 'ethereum');
    expect(mod.isGaslessSupported(d)).toBe(true);
  });

  it('USDC on base は true (Pimlico ERC20 paymaster 対応)', async () => {
    const mod = await import('@/lib/tokens');
    const d = mod.deploymentForSlug('usdc', 'base');
    expect(mod.isGaslessSupported(d)).toBe(true);
  });

  it('JPYC on polygon は true (Pimlico sponsorship paymaster)', async () => {
    const mod = await import('@/lib/tokens');
    const d = mod.deploymentForSlug('jpyc', 'polygon');
    expect(mod.isGaslessSupported(d)).toBe(true);
  });
});

describe('counterpartSymbol', () => {
  it('jpyc ⇄ usdc', () => {
    expect(counterpartSymbol('jpyc')).toBe('usdc');
    expect(counterpartSymbol('usdc')).toBe('jpyc');
  });
});

describe('displaySymbolFor', () => {
  it('jpyc → JPYC / usdc → USDC (deployment 由来の単一情報源)', () => {
    expect(displaySymbolFor('jpyc')).toBe('JPYC');
    expect(displaySymbolFor('usdc')).toBe('USDC');
  });
});

describe('symbolHasDeployment', () => {
  it('jpyc@polygon → true / usdc@polygon → true (両トークン同居)', () => {
    expect(symbolHasDeployment('jpyc', 'polygon')).toBe(true);
    expect(symbolHasDeployment('usdc', 'polygon')).toBe(true);
  });

  it('usdc@kaia → false (Kaia に native USDC 無し) / jpyc@base → false (JPYC は Polygon/Kaia のみ)', () => {
    expect(symbolHasDeployment('usdc', 'kaia')).toBe(false);
    expect(symbolHasDeployment('jpyc', 'base')).toBe(false);
    expect(symbolHasDeployment('jpyc', 'arbitrum')).toBe(false);
  });
});

describe('defaultConvertChainSlug', () => {
  it('jpyc@polygon → usdc: polygon 維持 (USDC も polygon に在る)', () => {
    expect(defaultConvertChainSlug('polygon', 'usdc')).toBe('polygon');
  });

  it('jpyc@kaia → usdc: Kaia に USDC 無し → usdc 既定 (base)', () => {
    expect(defaultConvertChainSlug('kaia', 'usdc')).toBe('base');
  });

  it('usdc@base → jpyc: Base に JPYC 無し → jpyc 既定 (polygon)', () => {
    expect(defaultConvertChainSlug('base', 'jpyc')).toBe('polygon');
  });

  it('usdc@polygon → jpyc: polygon 維持 (JPYC も polygon に在る)', () => {
    expect(defaultConvertChainSlug('polygon', 'jpyc')).toBe('polygon');
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
