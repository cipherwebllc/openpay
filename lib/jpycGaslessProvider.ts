// JPYC ガスレスの provider 解決層。EIP-3009 relay (Gelato・Polygon) と従来の Pimlico/7702
// sponsorship のどちらに倒すかを決める単一の真実点。resolveUsdcGaslessProvider (Circle 用)
// と同型。詳細・段階計画は memory:jpyc-eip3009。

import { polygon, polygonAmoy } from 'viem/chains';
import { env } from './env';
import type { TokenDeployment } from './tokens';

export type JpycGaslessProvider = 'eip3009-relay' | 'pimlico-7702';

// EIP-3009 relay (Gelato sponsoredCall) が対応する chain。/api/relay/jpyc の SUPPORTED_CHAINS
// と一致させる (Gelato は Polygon 対応・Kaia 非対応。Kaia は将来自前 relayer で別経路)。
const EIP3009_RELAY_CHAINS: ReadonlySet<number> = new Set([
  polygon.id,
  polygonAmoy.id,
]);

// JPYC ガスレスを EIP-3009 relay にするか、従来の Pimlico/7702 sponsorship にするか。
// flag OFF / 非 JPYC / relay 非対応 chain は 'pimlico-7702' (= 既存挙動、USDC 的 fallback)。
export function resolveJpycGaslessProvider(
  deployment: TokenDeployment,
  chainId: number,
): JpycGaslessProvider {
  if (!env.enableJpycEip3009) return 'pimlico-7702';
  if (deployment.symbol !== 'jpyc') return 'pimlico-7702';
  if (!EIP3009_RELAY_CHAINS.has(chainId)) return 'pimlico-7702';
  return 'eip3009-relay';
}
