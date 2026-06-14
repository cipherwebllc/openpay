// JPYC ガスレスの provider 解決層。EIP-3009 relay (Gelato・Polygon) と従来の Pimlico/7702
// sponsorship のどちらに倒すかを決める単一の真実点。resolveUsdcGaslessProvider (Circle 用)
// と同型。詳細・段階計画は memory:jpyc-eip3009。

import {
  polygon,
  polygonAmoy,
  kaia,
  kairos,
  avalanche,
  avalancheFuji,
} from 'viem/chains';
import { env } from './env';
import type { TokenDeployment } from './tokens';

export type JpycGaslessProvider = 'eip3009-relay' | 'pimlico-7702';

// EIP-3009 relay (自前 relayer) が対応する chain。/api/relay/jpyc の SUPPORTED_CHAINS と一致させる。
// Polygon は当初 Gelato だったが自前 relayer に移行済。Kaia は Gelato 非対応のため当初除外していたが、
// 自前 relayer 化で対応可能になった (relayer EOA に KAIA を入金して中継)。Avalanche/Fuji は
// env.enableJpycAvalanche=ON + forwarder 設定済のときに recover 経路で使う (recover-required)。
export const EIP3009_RELAY_CHAINS: ReadonlySet<number> = new Set([
  polygon.id,
  polygonAmoy.id,
  kaia.id,
  kairos.id,
  avalanche.id,
  avalancheFuji.id,
]);

// JPYC ガスレスを EIP-3009 relay にするか、従来の Pimlico/7702 sponsorship にするか。
// flag OFF / 非 JPYC / relay 非対応 chain は 'pimlico-7702' (= 既存挙動、USDC 的 fallback)。
export function resolveJpycGaslessProvider(
  deployment: TokenDeployment,
  chainId: number,
): JpycGaslessProvider {
  if (!env.enableJpycEip3009) return 'pimlico-7702';
  if (deployment.symbol !== 'jpyc') return 'pimlico-7702';
  // recover-required (Avalanche 等) は forwarder 未設定で deployment.paymasterMode='unavailable' に
  // なる (tokens.ts が forwarder 有無でゲート)。その JPYC は relay しない (free モードで OpenPay
  // relayer が AVAX を持ち出す赤字を防ぎ standard に倒す)。Polygon/Kaia は常に 'sponsorship' なので
  // 影響なし (= 既存挙動不変)。deployment を直接読むので tokens の runtime import は不要。
  if (deployment.paymasterMode === 'unavailable') return 'pimlico-7702';
  if (!EIP3009_RELAY_CHAINS.has(chainId)) return 'pimlico-7702';
  return 'eip3009-relay';
}
