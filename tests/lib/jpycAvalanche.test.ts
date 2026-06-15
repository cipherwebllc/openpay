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
import { avalanche, avalancheFuji, mainnet } from 'viem/chains';

// 有効な checksummed アドレス (forwarderConfig.test と同一)。configuredJpycForwarderFor は
// viem isAddress (strict checksum) で検証するため checksum が正しい必要がある。
const FUJI_FORWARDER = '0x0F4560a777415580F0680F8B56a79B0022C6B848';

const KEYS = [
  'NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE',
  'NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM',
  'NEXT_PUBLIC_ENABLE_JPYC_EIP3009',
  'NEXT_PUBLIC_ENABLE_USAGE_FEE',
  'NEXT_PUBLIC_NETWORK_ENV',
  'NEXT_PUBLIC_JPYC_FORWARDER_AVALANCHE',
  'NEXT_PUBLIC_JPYC_FORWARDER_FUJI',
  'NEXT_PUBLIC_JPYC_ETHEREUM_MAINNET_ADDRESS',
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
  const forwarderConfig = await import('@/lib/relay/forwarderConfig');
  return { chains, tokens, provider, relayProvider, forwarderConfig };
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

// Ethereum L1 は Avalanche と違い **standard モード固定** (L1 ガスは高変動で gasless recover が不経済)。
// forwarder env を設けない設計で paymasterMode は常に 'unavailable' → isGaslessSupported=false →
// URL/UI が standard を強制。さらに JPYC は L1 mainnet のみ (Sepolia 未 deploy) なので isMainnet ゲートも併用。
describe('Ethereum L1 JPYC enablement (NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM・standard 固定)', () => {
  it('フラグ OFF (既定): ethereum は JPYC_CHAINS 外・isJpycChainSlug は false (inert)', async () => {
    const { chains } = await loadWith({ NEXT_PUBLIC_NETWORK_ENV: 'mainnet' });
    expect(chains.JPYC_CHAINS).toEqual(['polygon', 'kaia']);
    expect(chains.isJpycChainSlug('ethereum')).toBe(false);
  });

  it('フラグ ON + mainnet: ethereum 追加・chainId=1・JPYC v3 同一アドレス・standard 固定 (unavailable)', async () => {
    const { chains, tokens } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'mainnet',
    });
    expect(chains.JPYC_CHAINS).toContain('ethereum');
    expect(chains.isJpycChainSlug('ethereum')).toBe(true);
    const dep = tokens.deploymentForSlug('jpyc', 'ethereum');
    expect(dep.chainId).toBe(mainnet.id);
    // JPYC v3 は L1 mainnet でも同一アドレス (実 RPC で JPY Coin/JPYC/18 を実証済)。
    expect(dep.address).toBe('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
    // forwarder 永久未設定 → gasless 非提供 → standard 固定 (顧客が ETH ガス負担)。
    expect(dep.paymasterMode).toBe('unavailable');
    expect(tokens.isGaslessSupported(dep)).toBe(false);
  });

  it('フラグ ON + mainnet: gasless provider は非 relay (paymasterMode=unavailable → pimlico-7702=standard)', async () => {
    const { tokens, provider } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM: '1',
      NEXT_PUBLIC_ENABLE_JPYC_EIP3009: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'mainnet',
    });
    const dep = tokens.deploymentForSlug('jpyc', 'ethereum');
    // eip3009 ON でも unavailable は relay に乗らず standard へ倒れる (ETH 持ち出し防止)。
    expect(provider.resolveJpycGaslessProvider(dep, dep.chainId)).toBe(
      'pimlico-7702',
    );
  });

  it('フラグ ON + testnet: ethereum は JPYC_CHAINS 外 (JPYC は L1 mainnet 限定・Sepolia 未 deploy)', async () => {
    const { chains } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
    });
    // isMainnet ゲートで testnet では追加されない (flag ON でも inert)。
    expect(chains.JPYC_CHAINS).toEqual(['polygon', 'kaia']);
    expect(chains.isJpycChainSlug('ethereum')).toBe(false);
  });

  it('mainnet.id は recover-required (flag 非依存) かつ forwarder は永久 null (standard 固定の根拠)', async () => {
    const { forwarderConfig } = await loadWith({});
    expect(forwarderConfig.isRecoverRequiredChain(mainnet.id)).toBe(true);
    // forwarder env を設けない設計 → 生の値も実効値も常に null → recoverMode に決して入らない。
    expect(forwarderConfig.configuredJpycForwarderFor(mainnet.id)).toBe(null);
    expect(forwarderConfig.jpycForwarderFor(mainnet.id)).toBe(null);
  });

  it('mainnet override env を設定すると ethereum address に反映 (緊急アドレス変更用)', async () => {
    const OVERRIDE = '0x0F4560a777415580F0680F8B56a79B0022C6B848';
    const { tokens } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'mainnet',
      NEXT_PUBLIC_JPYC_ETHEREUM_MAINNET_ADDRESS: OVERRIDE,
    });
    expect(tokens.deploymentForSlug('jpyc', 'ethereum').address).toBe(OVERRIDE);
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

  it('a1 (NEXT_PUBLIC_ENABLE_USAGE_FEE) ON + Fuji forwarder 設定済 → 実効 forwarder=null → unavailable (Codex P1#2)', async () => {
    // a1 と recover は排他: jpycForwarderFor は a1 ON で null を返す。paymasterMode が
    // configuredJpycForwarderFor (raw) を見ていると sponsorship 誤判定→server free→AVAX 持ち出し。
    // 実効 jpycForwarderFor を見ることで a1 ON 時は 'unavailable' → standard に倒れる。
    const { tokens } = await loadWith({
      NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1',
      NEXT_PUBLIC_NETWORK_ENV: 'testnet',
      NEXT_PUBLIC_JPYC_FORWARDER_FUJI: FUJI_FORWARDER,
      NEXT_PUBLIC_ENABLE_USAGE_FEE: '1',
    });
    expect(tokens.deploymentForSlug('jpyc', 'avalanche').paymasterMode).toBe(
      'unavailable',
    );
  });
});

describe('isRecoverRequiredChain (server 権威の free 禁止セット・flag 非依存)', () => {
  it('avalanche/fuji は recover-required・既存 chain は false', async () => {
    const { forwarderConfig } = await loadWith({});
    expect(forwarderConfig.isRecoverRequiredChain(avalanche.id)).toBe(true);
    expect(forwarderConfig.isRecoverRequiredChain(avalancheFuji.id)).toBe(true);
    expect(forwarderConfig.isRecoverRequiredChain(137)).toBe(false);
    expect(forwarderConfig.isRecoverRequiredChain(8217)).toBe(false);
  });

  it('flag OFF でも recover-required 判定は有効 (client ゲート迂回 POST への server 安全策)', async () => {
    const { forwarderConfig } = await loadWith({});
    expect(forwarderConfig.isRecoverRequiredChain(avalanche.id)).toBe(true);
  });
});

describe('EIP3009_RELAY_CHAINS の Avalanche/Fuji 包含は flag で制御 (Codex P2: flag-off 完全 inert)', () => {
  it('flag ON: avalanche.id (43114) と avalancheFuji.id (43113) が relay 対応 chain', async () => {
    const { provider } = await loadWith({ NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE: '1' });
    expect(provider.EIP3009_RELAY_CHAINS.has(avalanche.id)).toBe(true);
    expect(provider.EIP3009_RELAY_CHAINS.has(avalancheFuji.id)).toBe(true);
  });

  it('flag OFF (既定): avalanche/fuji は EIP3009_RELAY_CHAINS に含まれない (inert)', async () => {
    const { provider } = await loadWith({});
    expect(provider.EIP3009_RELAY_CHAINS.has(avalanche.id)).toBe(false);
    expect(provider.EIP3009_RELAY_CHAINS.has(avalancheFuji.id)).toBe(false);
    // 既存 chain は不変。
    expect(provider.EIP3009_RELAY_CHAINS.has(137)).toBe(true);
  });
});

describe('relayMaxGasCostWei — per-chain gas 上限 (AVAX は native 価値が桁違い)', () => {
  it('全て未設定 → 0n (上限なし・testnet 既定)', async () => {
    const { relayProvider } = await loadWith({});
    expect(relayProvider.relayMaxGasCostWei(avalanche.id)).toBe(0n);
  });

  it('グローバルのみ設定: 既存 chain はグローバル値・Avalanche は global fallback を使わず 0n (Codex P1)', async () => {
    const { relayProvider } = await loadWith({
      RELAY_MAX_GAS_COST_WEI: '10000000000000000', // 0.01 (POL/KAIA 用)
    });
    // 既存 chain (Polygon 137) はグローバル値 (後方互換)。
    expect(relayProvider.relayMaxGasCostWei(137)).toBe(10000000000000000n);
    // ⚠️ Avalanche は recover-required: POL/KAIA 用グローバル値を流用しない (AVAX には過大)。
    // per-chain 未設定 → 0n → mainnet B5 gate が 503 で点灯を止める。
    expect(relayProvider.relayMaxGasCostWei(avalanche.id)).toBe(0n);
    expect(relayProvider.relayMaxGasCostWei(avalancheFuji.id)).toBe(0n);
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

  it('per-chain env が不正値 (非数値) → 無視し recover-required の 0n に倒す (不正入力)', async () => {
    const { relayProvider } = await loadWith({
      RELAY_MAX_GAS_COST_WEI_AVALANCHE: 'abc', // 非数値 → /^[0-9]+$/ 不一致で無視
      RELAY_MAX_GAS_COST_WEI: '10000000000000000', // グローバルはあるが recover-required は流用しない
    });
    // 不正な per-chain 値は黙って無視され、グローバル fallback にも倒れず 0n (赤字素通しを防ぐ安全側)。
    expect(relayProvider.relayMaxGasCostWei(avalanche.id)).toBe(0n);
  });
});
