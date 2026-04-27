// Pimlico bundler/paymaster URL は同一エンドポイント。EntryPoint v0.7 を使用。
//
// 2 種類の Paymaster を token に応じて使い分ける:
//   - JPYC (Polygon): Sponsorship (Verifying) Paymaster
//       運営が POL ガスを肩代わり (15 JPYC フロアで黒字)
//   - USDC (Base):    ERC20 Paymaster
//       顧客が USDC でガスを支払う (Base ETH 立替えの赤字リスク回避)
//
// testnet (Base Sepolia) では USDC でも sponsorship に倒す運用判断。
// 動作確認時に testnet ETH + USDC の両方を用意する手間を省くため。
import { http } from 'viem';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { entryPoint07Address } from 'viem/account-abstraction';
import { env, isMainnet } from './env';
import { TOKENS, type PaymasterMode, type TokenSymbol } from './tokens';

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

/** token と現在のネットワーク (mainnet/testnet) から paymaster mode を決定 */
export function resolvePaymasterMode(token: TokenSymbol): PaymasterMode {
  const declared = TOKENS[token].paymasterMode;
  // testnet では erc20 → sponsorship に倒す。動作確認時に testnet 用の
  // ETH + USDC の両方を用意せずに済ませる運用判断。
  if (declared === 'erc20' && !isMainnet) return 'sponsorship';
  return declared;
}

/** sponsorship のとき env で policy id が無ければ undefined (sponsor なし扱い) */
export function pimlicoPaymasterContext(
  token: TokenSymbol,
):
  | { sponsorshipPolicyId: string }
  | { token: `0x${string}` }
  | undefined {
  if (resolvePaymasterMode(token) === 'erc20') {
    return { token: TOKENS[token].address };
  }
  return env.pimlicoSponsorshipPolicyId
    ? { sponsorshipPolicyId: env.pimlicoSponsorshipPolicyId }
    : undefined;
}
