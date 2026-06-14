// Phase 2 (Avalanche/Fuji を JPYC チェーンとして追加) のフラグ挙動を実モジュールで固定する。
// env を確定 → resetModules → 動的 import で「実モジュール」を与えた env で評価する
// (mock 無し・実 chains/tokens/jpycGaslessProvider/relayProvider の実コードパス)。
//
// 核となる不変条件:
//   - フラグ OFF (既定) = JPYC_CHAINS は ['polygon','kaia'] のまま (挙動完全不変・inert)。
//   - フラグ ON = Avalanche 追加。ただし **recover-required**: forwarder 未設定なら
//     paymasterMode='unavailable' → isGaslessSupported=false → resolveJpycGaslessProvider が
//     'pimlico-7702' (= 非 relay・standard へ倒す) を返し、free モードの AVAX 持ち出しを防ぐ。
//   - forwarder 設定済 = paymasterMode='sponsorship' → 'eip3009-relay' (recover)。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { avalanche, avalancheFuji } from 'viem/chains';

// 有効な checksummed アドレス (forwarderConfig.test と同一)。configuredJpycForwarderFor は
// viem isAddress (strict checksum) で検証するため checksum が正しい必要がある。
const FUJI_FORWARDER = '0x0F4560a777415580F0680F8B56a79B0022C6B848';

const KEYS = [
  'NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE',
  'NEXT_PUBLIC_ENABLE_JPYC_EIP3009',
  'NEXT_PUBLIC_NETWORK_ENV',
  'NEXT_PUBLIC_JPYC_FORWARDER_AVALANCHE',
  'NEXT_PUBLIC_JPYC_FORWARDER_FUJI',
  'RELAY_MAX_GAS_COST_WEI',
  'RELAY_MAX_GAS_COST_WEI_AVALANCHE',
  'RELAY_MAX_GAS_COST_WEI_FUJI',
] as const;

type Key = (typeof KEYS)[number];

async function loadWith(envVars: Partial<Record<Key, string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, envVars);
  vi.resetModules();
  const chains = await import('@/lib/chains');
  const tokens = await import('@/lib/tokens');
  const provider = await import('@/lib/jpycGaslessProvider');
  const relayProvider = await import('@/lib/relay/relayProvider');
  return { chains, tokens, provider, relayProvider };
}

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.resetModules();
});

describe('Avalanche JPYC enablement flag (NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE)', () => {
  it('フラグ OFF (既定): JPYC_CHAINS は [polygon, kaia] のまま・avalanche は受理されない (inert)', async () => {
    const { chains, tokens } = await loadWith({});
    expect(chains.JPYC_CHAINS).toEqual(['polygon', 'kaia']);
    expect(chains.isJpycChainSlug('avalanche')).toBe(false);
    // deployment も avalanche を含まない。
    expect(tokens.deploymentsForSymbol('jpyc')).toHaveLength(2);
  });

  it('フラグ ON: JPYC_CHAINS に avalanche 追加・isJpycChainSlug 受理・deployment 3 件', async () => {
    const { chains, tokens } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
    });
    expect(chains.JPYC_CHAINS).toEqual(['polygon', 'kaia', 'avalanche']);
    expect(chains.isJpycChainSlug('avalanche')).toBe(true);
    expect(tokens.deploymentsForSymbol('jpyc')).toHaveLength(3);
  });

  it('フラグ ON + testnet: avalanche slug は Fuji (43113) を解決・JPYC v3 同一アドレス', async () => {
    const { tokens } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
    });
    const dep = tokens.deploymentForSlug('jpyc', 'avalanche');
    expect(dep.chainId).toBe(avalancheFuji.id);
    expect(dep.address).toBe('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
  });

  it('フラグ ON + mainnet: avalanche slug は Avalanche (43114) を解決', async () => {
    const { tokens } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'mainnet',
    });
    const dep = tokens.deploymentForSlug('jpyc', 'avalanche');
    expect(dep.chainId).toBe(avalanche.id);
  });
});

describe('Avalanche recover-required (forwarder 有無で gasless 可否)', () => {
  it('forwarder 未設定: paymasterMode=unavailable → isGaslessSupported=false → 非 relay (standard)', async () => {
    const { tokens, provider } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_ENABLE_JPYC_EIP3009: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
      // Fuji forwarder は未設定。
    });
    const dep = tokens.deploymentForSlug('jpyc', 'avalanche');
    expect(dep.paymasterMode).toBe('unavailable');
    expect(tokens.isGaslessSupported(dep)).toBe(false);
    // recover-required: relay せず 'pimlico-7702' (= 非 relay → URL/UI が standard へ倒す)。
    expect(provider.resolveJpycGaslessProvider(dep, dep.chainId)).toBe(
      'pimlico-7702',
    );
  });

  it('forwarder 設定済: paymasterMode=sponsorship → eip3009-relay (recover)', async () => {
    const { tokens, provider } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_ENABLE_JPYC_EIP3009: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
      NEXT_PUBLIC_JPYC_FORWARDER_FUJI: FUJI_FORWARDER,
    });
    const dep = tokens.deploymentForSlug('jpyc', 'avalanche');
    expect(dep.paymasterMode).toBe('sponsorship');
    expect(tokens.isGaslessSupported(dep)).toBe(true);
    expect(provider.resolveJpycGaslessProvider(dep, dep.chainId)).toBe(
      'eip3009-relay',
    );
  });

  it('Polygon/Kaia は forwarder 無しでも常に sponsorship (recover-required は Avalanche のみ)', async () => {
    const { tokens } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
    });
    expect(tokens.deploymentForSlug('jpyc', 'polygon').paymasterMode).toBe(
      'sponsorship',
    );
    expect(tokens.deploymentForSlug('jpyc', 'kaia').paymasterMode).toBe(
      'sponsorship',
    );
  });
});

describe('EIP3009_RELAY_CHAINS に Avalanche/Fuji を含む', () => {
  it('avalanche.id (43114) と avalancheFuji.id (43113) が relay 対応 chain', async () => {
    const { provider } = await loadWith({});
    expect(provider.EIP3009_RELAY_CHAINS.has(avalanche.id)).toBe(true);
    expect(provider.EIP3009_RELAY_CHAINS.has(avalancheFuji.id)).toBe(true);
  });
});

describe('relayMaxGasCostWei — per-chain gas 上限 (AVAX は native 価値が桁違い)', () => {
  it('全て未設定 → 0n (上限なし・testnet 既定)', async () => {
    const { relayProvider } = await loadWith({});
    expect(relayProvider.relayMaxGasCostWei(avalanche.id)).toBe(0n);
  });

  it('グローバルのみ設定 → 全 chain がグローバル値 (後方互換)', async () => {
    const { relayProvider } = await loadWith({
      RELAY_MAX_GAS_COST_WEI: '10000000000000000', // 0.01
    });
    expect(relayProvider.relayMaxGasCostWei(avalanche.id)).toBe(
      10000000000000000n,
    );
  });

  it('per-chain (Avalanche) はグローバルより優先 (AVAX 専用上限)', async () => {
    const { relayProvider } = await loadWith({
      RELAY_MAX_GAS_COST_WEI: '10000000000000000', // POL/KAIA 用
      RELAY_MAX_GAS_COST_WEI_AVALANCHE: '50000000000000000', // 0.05 AVAX
    });
    expect(relayProvider.relayMaxGasCostWei(avalanche.id)).toBe(
      50000000000000000n,
    );
    // 他 chain はグローバルのまま (chain 独立)。
    expect(relayProvider.relayMaxGasCostWei(137)).toBe(10000000000000000n);
  });

  it('Fuji per-chain も独立に効く', async () => {
    const { relayProvider } = await loadWith({
      RELAY_MAX_GAS_COST_WEI_FUJI: '50000000000000000',
    });
    expect(relayProvider.relayMaxGasCostWei(avalancheFuji.id)).toBe(
      50000000000000000n,
    );
    // Avalanche mainnet は未設定 → 0n (グローバルも無し)。
    expect(relayProvider.relayMaxGasCostWei(avalanche.id)).toBe(0n);
  });
});
