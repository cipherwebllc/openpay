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
import { isSupportedChainId, chainSupportsCanonical7702 } from '@/lib/chains';
import {
  detectAccountKind,
  IncompatibleSmartAccountError,
  isIncompatibleSmartAccountError,
} from '@/lib/accountDetection';
import { buildSimpleSmartAccountClient } from '@/lib/smartAccount/simpleAccount';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { TokenDeployment } from '@/lib/tokens';

export function useSmartAccount(
  deployment: TokenDeployment,
  enabled: boolean = true,
  // Circle 経路を抑止して Pimlico erc20 に倒すフラグ。Circle 分岐 (useBatchPayment) は
  // circlePermitAmount (useGasQuoteCircle 由来) を必須とするため、Circle を配線していない
  // 呼出元 (TipForm) が pimlico-simple-7702 + USDC + Circle 有効 chain で Circle に routing
  // されると送信時に "permitAmount 未算定" で throw する。そうした文脈で true を渡す。
  disableCircle: boolean = false,
) {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { address, chainId } = useAccount();

  // USDC ガスレスを Circle Paymaster (v0.8) で組むか Pimlico erc20 (v0.7) のままに
  // するかの解決 (単一の真実点)。queryKey に provider/entryPointVersion を含めて、
  // flag/chain 変更で別 client を作り直させる (staleTime:Infinity のキャッシュ汚染防止)。
  const usdcProvider = disableCircle
    ? 'pimlico'
    : resolveUsdcGaslessProvider(deployment, chainId ?? deployment.chainId);
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

      // canonical EIP-7702 非対応 chain (Avalanche C-Chain = ACP-209「7702 style」AA) の
      // ガード。委任済み (= 7702 系: pimlico-simple / mav2 / metamask) の口は、どの builder に
      // routing しても標準 bundler/EntryPoint 経由の 7702 UserOp が送信時に AA23 で revert する
      // (chain レベルの非互換・2026-05-31 ゲート実証)。kind 別の builder に入る前に fail-fast し、
      // standard mode 案内 (errorChainNo7702) に倒す。pristine ('none') / unknown は下の既存分岐で
      // それぞれ standard / 案内に倒れるため、ここでは既知の 7702 委任 kind のみを対象にする。
      const isDelegated7702Kind =
        detection.kind === 'pimlico-simple-7702' ||
        detection.kind === 'alchemy-mav2-7702' ||
        detection.kind === 'metamask-7702';
      if (isDelegated7702Kind && !chainSupportsCanonical7702(chainId)) {
        logger.warn('smart_account.non_canonical_7702_chain', {
          chainId,
          kind: detection.kind,
          delegateAddress: detection.delegateAddress,
          symbol: deployment.symbol,
        });
        throw new IncompatibleSmartAccountError({
          delegateAddress: detection.delegateAddress,
          i18nKey: 'errorChainNo7702',
        });
      }

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
          // Circle 経路 (viem account-abstraction + permit/verifier 群) は dynamic import で
          // /pay /checkout の baseline bundle から外す (flag OFF の大多数で未ロード・mav2/
          // metamask と同方針)。bundle budget (/pay 420kB) を超えないため必須。
          const { buildCircleSmartAccountClient } = await import(
            '@/lib/smartAccount/circleAccount'
          );
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
        // ⚠️ MetaMask Smart Account (Stateless7702) ガスレスは現在 viem ↔
        // @metamask/delegation-toolkit の非互換で全件失敗する: Stateless7702 は
        // account.address === 署名 EOA で、viem 2.50 の ERC-7739 ガードが「外部署名で
        // verifyingContract に同一(internal)アドレスは不可」と弾く ("External signature
        // requests cannot use internal accounts as the verifying contract")。toolkit 0.13.0
        // が最新で upstream 修正待ち。既定 OFF で standard mode に倒し、生エラーを出さない。
        // upstream 互換修正 + 実機再検証後に NEXT_PUBLIC_ENABLE_METAMASK_SMART_ACCOUNT で再有効化。
        if (!env.enableMetaMaskSmartAccount) {
          logger.warn('smart_account.metamask_gasless_disabled', {
            delegateAddress: detection.delegateAddress,
            chainId,
            symbol: deployment.symbol,
          });
          throw new IncompatibleSmartAccountError({
            delegateAddress: detection.delegateAddress,
            i18nKey: 'errorMetaMaskGaslessUnavailable',
          });
        }
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
