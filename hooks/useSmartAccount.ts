'use client';

// EOA の 7702 delegation 状態を `eth_getCode` で検出し、適切な SmartAccount
// client builder に分岐する router。
//
// - pimlico-simple-7702 → permissionless `to7702SimpleSmartAccount` 経路 (既に委任済み
//   なのでガスレスで動く)
// - none (pristine 未委任) → injected wallet では初回 7702 委任を gasless に張れない
//   (viem signAuthorization が JSON-RPC 非対応 → authorization がダミー署名のまま
//   bundler に弾かれる) ため IncompatibleSmartAccountError(errorPristineNoBootstrap)
//   を throw し、UI を standard mode 案内に倒す
// - alchemy-mav2-7702 → `@account-kit/smart-contracts` 経由の MAv2 経路
//   HashPort wallet 等が EOA を Alchemy MAv2 へ自動委任しているケース。
//   Pimlico bundler / paymaster は両者で共有 (account 層だけ差替)。
//   feature flag NEXT_PUBLIC_ENABLE_MAV2 が立っている時のみ有効。
// - metamask-7702 → `@metamask/delegation-toolkit` (toMetaMaskSmartAccount +
//   Stateless7702) 経由。MetaMask Smart Account 新規 install ユーザ (2025 春〜
//   自動委任) を救済。Pimlico bundler は first-class 対応 (EntryPoint v0.7)。
//   Kaia は MetaMask 未 deploy のため builder 側で chain guard。
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
  isIncompatibleSmartAccountError,
} from '@/lib/accountDetection';
import { buildSimpleSmartAccountClient } from '@/lib/smartAccount/simpleAccount';
import { buildCircleSmartAccountClient } from '@/lib/smartAccount/circleAccount';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
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

  // USDC ガスレスを Circle Paymaster (v0.8) で組むか Pimlico erc20 (v0.7) のままに
  // するかの解決 (単一の真実点)。queryKey に provider/entryPointVersion を含めて、
  // flag/chain 変更で別 client を作り直させる (staleTime:Infinity のキャッシュ汚染防止)。
  const usdcProvider = resolveUsdcGaslessProvider(
    deployment,
    chainId ?? deployment.chainId,
  );
  const entryPointVersion = usdcProvider === 'circle' ? '0.8' : '0.7';

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
      usdcProvider,
      entryPointVersion,
    ],
    queryFn: async () => {
      // enabled で全条件を確認済みだが TS の narrowing のために再チェック
      if (!walletClient || !publicClient || !chainId || !address) {
        throw new Error('not ready');
      }

      const detection = await detectAccountKind(publicClient, address);

      // 既に Pimlico SimpleAccount に委任済みの口。委任先 impl (0xe6Cae83) は
      // Circle v0.8 経路 (permissionless to7702SimpleSmartAccount 既定) と同一なので、
      // **再委任なし**で Circle Paymaster (USDC ガスレス) に routing できる。
      // Circle に倒すのは「USDC + erc20 + allowlist+fee 在り + flag ON」を満たし、かつ
      // 既委任 (pimlico-simple-7702) の時だけ — pristine は signAuthorization 非対応で
      // 手前の detection.kind==='none' で errorPristineNoBootstrap に倒れるため到達しない。
      if (detection.kind === 'pimlico-simple-7702') {
        if (usdcProvider === 'circle') {
          logger.info('smart_account.circle_routed', {
            chainId,
            symbol: deployment.symbol,
          });
          return buildCircleSmartAccountClient({
            walletClient,
            publicClient,
            chainId,
            deployment,
          });
        }
        return buildSimpleSmartAccountClient({
          walletClient,
          publicClient,
          chainId,
          deployment,
        });
      }

      // pristine EOA (未委任): 初回のガスレス決済は 7702 委任を設定する署名済み
      // authorization を要するが、viem の signAuthorization は injected (JSON-RPC)
      // wallet を非対応のため、Simple7702 経路ではダミー署名のまま送られ bundler が
      // "recovered signer ≠ sender" で必ず弾く。事前に fail-fast して UI を standard
      // mode 案内に倒す (送信時の生 bundler エラーを避ける)。MetaMask 等でアカウントを
      // Smart Account 化 (= 委任) すれば次回から 'metamask-7702' 等で gasless に動く。
      if (detection.kind === 'none') {
        // Sentry 観測: 初回ガスレス不可で standard に倒れた頻度 (需要/離脱の計測)。
        logger.info('smart_account.pristine_no_bootstrap', {
          chainId,
          symbol: deployment.symbol,
        });
        throw new IncompatibleSmartAccountError({
          delegateAddress: null,
          i18nKey: 'errorPristineNoBootstrap',
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

      if (detection.kind === 'metamask-7702') {
        // Sentry 観測: MetaMask SC ユーザの流入頻度 (将来の対応範囲判断 / 計測用)。
        logger.info('smart_account.metamask_detected', {
          delegateAddress: detection.delegateAddress,
          chainId,
          symbol: deployment.symbol,
        });
        // @metamask/delegation-toolkit は ~30 kB gzip。MetaMask Smart Account
        // ユーザ向けにのみ必要なので dynamic import で lazy load。
        const { buildMetaMaskSmartAccountClient } = await import(
          '@/lib/smartAccount/metamask'
        );
        return buildMetaMaskSmartAccountClient({
          walletClient,
          publicClient,
          chainId,
          account: address,
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
    // 互換性エラー (pristine / 未対応 delegate / Kaia 等) は決定論的なので retry しても
    // 結果は変わらず、UI フォールバック (standard 案内バナー) が backoff 分だけ遅れ、
    // telemetry も多重発火する。これらは即 fail-fast。RPC flake 等の transient error
    // のみ React Query default と同じ 3 回まで retry する。
    retry: (failureCount, error) =>
      isIncompatibleSmartAccountError(error) ? false : failureCount < 3,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}
