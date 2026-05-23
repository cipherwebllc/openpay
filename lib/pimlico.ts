// Pimlico bundler/paymaster URL は同一エンドポイント。EntryPoint v0.7 を使用。
//
// 3 種類の Paymaster mode を deployment.paymasterMode に応じて使い分ける:
//   - JPYC (Polygon / Kaia): Sponsorship (Verifying) Paymaster
//       運営が POL/KAIA ガスを肩代わり (gas 見積バッファで採算確保)
//   - USDC (Base / Arbitrum / Optimism / Polygon): ERC20 Paymaster
//       顧客が USDC でガスを支払う (ネイティブ ETH/POL 立替えの赤字リスク回避)
//   - USDC (Ethereum L1): unavailable
//       Pimlico ERC20 paymaster 未 deploy。standard mode (wallet 直接送信) 必須。
//       URL parser が gasless+ethereum-USDC 組合せを reject するため、本 file の
//       関数群が 'unavailable' を受けるのは misuse のみ → throw で fail-loud。
//       sponsorship 自動 fallback は禁止 (運営の sponsorship 残高を 任意 transfer
//       で吸われる security incident に直結するため)。
//
// testnet (Base Sepolia / Arbitrum Sepolia / Optimism Sepolia / Polygon Amoy) では
// USDC でも sponsorship に倒す運用判断。動作確認時に testnet ネイティブ + USDC の両方を
// 用意する手間を省くため (Ethereum Sepolia USDC も同じく sponsorship)。
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

/** deployment と現在のネットワーク (mainnet/testnet) から paymaster mode を決定。
 * mainnet の Ethereum USDC は `unavailable` をそのまま返す。testnet の Ethereum
 * Sepolia USDC は他の testnet と同じく sponsorship に倒す (動作確認簡略化)。 */
export function resolvePaymasterMode(
  deployment: TokenDeployment,
): PaymasterMode {
  if (deployment.paymasterMode === 'unavailable') {
    if (!isMainnet) return 'sponsorship';
    return 'unavailable';
  }
  // testnet では erc20 → sponsorship に倒す。動作確認時に testnet 用の
  // ネイティブガス + USDC の両方を用意せずに済ませる運用判断。
  if (deployment.paymasterMode === 'erc20' && !isMainnet) return 'sponsorship';
  return deployment.paymasterMode;
}

/** sponsorship のとき env で policy id が無ければ undefined (sponsor なし扱い)。
 * 'unavailable' deployment が混入したら throw — URL parser が事前に弾いている
 * 前提で、ここに到達するのは PaymentForm/呼出側の bug。silent fallback で
 * sponsorship を返すと運営の sponsorship 残高で任意 transfer が成立してしまう
 * ため、確実に fail-loud させる。 */
export function pimlicoPaymasterContext(
  deployment: TokenDeployment,
):
  | { sponsorshipPolicyId: string }
  | { token: TokenDeployment['address'] }
  | undefined {
  const mode = resolvePaymasterMode(deployment);
  if (mode === 'unavailable') {
    throw new Error(
      `pimlicoPaymasterContext: deployment ${deployment.symbol} on chain ${deployment.chainId} ` +
        'は gasless mode 非対応 (paymasterMode=unavailable)。URL parser で reject ' +
        'されているはずで、ここに到達するのは呼出側の bug。',
    );
  }
  if (mode === 'erc20') {
    return { token: deployment.address };
  }
  return env.pimlicoSponsorshipPolicyId
    ? { sponsorshipPolicyId: env.pimlicoSponsorshipPolicyId }
    : undefined;
}
