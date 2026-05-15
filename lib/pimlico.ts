// Pimlico bundler/paymaster URL は同一エンドポイント。EntryPoint v0.7 を使用。
//
// 2 種類の Paymaster を deployment.paymasterMode に応じて使い分ける:
//   - JPYC (Polygon): Sponsorship (Verifying) Paymaster
//       運営が POL ガスを肩代わり (gas 見積バッファで採算確保、MIN_FEE は撤廃)
//   - USDC (Base / Arbitrum / Optimism / Polygon): ERC20 Paymaster
//       顧客が USDC でガスを支払う (ネイティブ ETH/POL 立替えの赤字リスク回避)
//
// testnet (Base Sepolia / Arbitrum Sepolia / Optimism Sepolia / Polygon Amoy) では
// USDC でも sponsorship に倒す運用判断。動作確認時に testnet ネイティブ + USDC の両方を
// 用意する手間を省くため。
import { http } from 'viem';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { entryPoint07Address } from 'viem/account-abstraction';
import { env, isMainnet } from './env';
import type { PaymasterMode, TokenDeployment } from './tokens';

export function pimlicoUrl(chainId: number): string {
  if (!env.pimlicoApiKey) {
    throw new Error(
      'NEXT_PUBLIC_PIMLICO_API_KEY が未設定です。.env.local を確認してください。',
    );
  }
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${env.pimlicoApiKey}`;
}

export function createPimlico(chainId: number) {
  return createPimlicoClient({
    transport: http(pimlicoUrl(chainId)),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });
}

/** deployment と現在のネットワーク (mainnet/testnet) から paymaster mode を決定 */
export function resolvePaymasterMode(
  deployment: TokenDeployment,
): PaymasterMode {
  // testnet では erc20 → sponsorship に倒す。動作確認時に testnet 用の
  // ネイティブガス + USDC の両方を用意せずに済ませる運用判断。
  if (deployment.paymasterMode === 'erc20' && !isMainnet) return 'sponsorship';
  return deployment.paymasterMode;
}

/** sponsorship のとき env で policy id が無ければ undefined (sponsor なし扱い) */
export function pimlicoPaymasterContext(
  deployment: TokenDeployment,
):
  | { sponsorshipPolicyId: string }
  | { token: TokenDeployment['address'] }
  | undefined {
  if (resolvePaymasterMode(deployment) === 'erc20') {
    return { token: deployment.address };
  }
  return env.pimlicoSponsorshipPolicyId
    ? { sponsorshipPolicyId: env.pimlicoSponsorshipPolicyId }
    : undefined;
}
