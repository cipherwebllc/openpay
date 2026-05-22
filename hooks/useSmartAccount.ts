'use client';

// EOA の 7702 delegation 状態を `eth_getCode` で検出し、適切な SmartAccount
// client builder に分岐する router。
//
// - none / pimlico-simple-7702 → permissionless `to7702SimpleSmartAccount` 経路
//   (旧来の挙動、振る舞い無変更)
// - alchemy-mav2-7702 → `@account-kit/smart-contracts` 経由の MAv2 経路
//   HashPort wallet 等が EOA を Alchemy MAv2 へ自動委任しているケース。
//   Pimlico bundler / paymaster は両者で共有 (account 層だけ差替)。
//   feature flag NEXT_PUBLIC_ENABLE_MAV2 が立っている時のみ有効。
// - unknown / mav2 (flag off) → IncompatibleSmartAccountError throw、UI は
//   i18n された案内を出す。
//
// useBatchPayment / useGasQuote* など下流 consumer は引き続き返り値を
// `{ smartAccountClient, pimlicoClient, paymasterMode }` で受け取るので
// 振る舞いは無変更。

import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { isSupportedChainId } from '@/lib/chains';
import {
  detectAccountKind,
  IncompatibleSmartAccountError,
} from '@/lib/accountDetection';
import { buildSimpleSmartAccountClient } from '@/lib/smartAccount/simpleAccount';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { TokenDeployment } from '@/lib/tokens';

export function useSmartAccount(
  deployment: TokenDeployment,
  enabled: boolean = true,
) {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { address, chainId } = useAccount();

  return useQuery({
    enabled:
      enabled &&
      !!walletClient &&
      !!publicClient &&
      !!address &&
      isSupportedChainId(chainId) &&
      chainId === deployment.chainId,
    queryKey: [
      'openpay',
      'smart-account',
      address,
      chainId,
      deployment.symbol,
      deployment.chainId,
    ],
    queryFn: async () => {
      // enabled で全条件を確認済みだが TS の narrowing のために再チェック
      if (!walletClient || !publicClient || !chainId || !address) {
        throw new Error('not ready');
      }

      const detection = await detectAccountKind(publicClient, address);

      if (
        detection.kind === 'none' ||
        detection.kind === 'pimlico-simple-7702'
      ) {
        return buildSimpleSmartAccountClient({
          walletClient,
          publicClient,
          chainId,
          deployment,
        });
      }

      if (detection.kind === 'alchemy-mav2-7702') {
        if (!env.enableMav2) {
          // Sentry 観測: MAv2 wallet (HashPort 等) が来ているのに feature flag
          // off の頻度。enable 判断のためのデマンド signal。
          logger.warn('smart_account.mav2_disabled', {
            delegateAddress: detection.delegateAddress,
            chainId,
            symbol: deployment.symbol,
          });
          throw new IncompatibleSmartAccountError({
            delegateAddress: detection.delegateAddress,
            i18nKey: 'errorMav2Disabled',
          });
        }
        // MAv2 SDK (約 4 kB gzip) は HashPort ユーザのみで必要。
        // dynamic import で /pay /tip /checkout の baseline bundle に
        // 含めない (lazy load される)。
        const { buildMav2SmartAccountClient } = await import(
          '@/lib/smartAccount/mav2'
        );
        return buildMav2SmartAccountClient({
          walletClient,
          publicClient,
          chain: walletClient.chain,
          chainId,
          deployment,
        });
      }

      // unknown delegation: 既知の MAv2 / Pimlico SimpleAccount いずれでもない。
      // 互換性が取れないので明示的に block して UI で案内する。Sentry 観測で
      // 「未知の delegate address」を集計し、新規 wallet 種別の流入を検知。
      logger.warn('smart_account.unknown_delegation', {
        delegateAddress: detection.delegateAddress,
        chainId,
        symbol: deployment.symbol,
      });
      throw new IncompatibleSmartAccountError({
        delegateAddress: detection.delegateAddress,
        i18nKey: 'errorIncompatibleSmartAccount',
      });
    },
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}
