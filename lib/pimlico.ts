// Pimlico bundler/paymaster URL は同一エンドポイント。EntryPoint v0.7 を使用。
// 本 MVP は Sponsorship (Verifying) Paymaster で運営がガスを肩代わりする (README 参照)。
import { http } from 'viem';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { entryPoint07Address } from 'viem/account-abstraction';
import { env } from './env';

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

export function pimlicoPaymasterContext():
  | { sponsorshipPolicyId: string }
  | undefined {
  return env.pimlicoSponsorshipPolicyId
    ? { sponsorshipPolicyId: env.pimlicoSponsorshipPolicyId }
    : undefined;
}
