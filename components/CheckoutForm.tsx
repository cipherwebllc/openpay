'use client';

// セキュリティ: webhook payload と success_url の query は顧客側で改ざん可能
// (Stripe の whsec_ 署名相当の保証はない)。マーチャントは tx_hash を必ず
// on-chain で再検証してから注文を確定する責務を負う。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { useAccount, useSwitchChain } from 'wagmi';
import { ConnectButton } from './ConnectButton';
import { InfoTooltip } from './InfoTooltip';
import { OnrampCta } from './OnrampCta';
import { ResultRow } from './ResultRow';
import { Row } from './Row';
import { SmartAccountFallbackBanner } from './SmartAccountFallbackBanner';
import { SuccessOverlay } from './SuccessOverlay';
import { PayerReceiptCompletion } from './PayerReceiptCompletion';
import { useBatchPayment } from '@/hooks/useBatchPayment';
import { useStandardPayment } from '@/hooks/useStandardPayment';
import { useSmartAccount } from '@/hooks/useSmartAccount';
import { useGasQuote } from '@/hooks/useGasQuote';
import { useGasQuoteCircle } from '@/hooks/useGasQuoteCircle';
import { useJpycEip3009Payment } from '@/hooks/useJpycEip3009Payment';
import { resolveUsdcGaslessProvider } from '@/lib/circlePaymaster';
import { resolveJpycGaslessProvider } from '@/lib/jpycGaslessProvider';
import { jpycForwarderFor, relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { relayErrorKey } from '@/lib/relay/relayErrorMessage';
import { useErc20BalanceAndChain } from '@/hooks/useErc20BalanceAndChain';
import { calcBreakdown } from '@/lib/fee';
import { blockExplorerUrl, chainForSlug } from '@/lib/chains';
import { env } from '@/lib/env';
import { primeChimeAudio } from '@/lib/successChime';
import { isGasCongestedError } from '@/lib/gasCeiling';
import { isIncompatibleSmartAccountError } from '@/lib/accountDetection';
import { logger } from '@/lib/logger';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { useRelayGaslessSnapshot } from '@/hooks/useRelayGaslessSnapshot';
import { resolvePaymasterMode } from '@/lib/pimlico';
import { DEFAULT_CHAIN_FOR_SYMBOL, deploymentForSlug } from '@/lib/tokens';
import {
  calcCheckoutTotal,
  type CheckoutParams,
} from '@/lib/url';
import { taxAmountDecimal, taxDisplayDecimals } from '@/lib/tax';
import { formatTokenAmount, shortAddress } from '@/lib/format';

const SUCCESS_REDIRECT_DELAY_MS = 3000;

export function CheckoutForm({ params }: { params: CheckoutParams }) {
  const t = useTranslations('CheckoutForm');
  const locale = useLocale();
  const router = useRouter();
  const [modeOverride, setModeOverride] = useState<'standard' | null>(null);

  const chainSlug = params.chain ?? DEFAULT_CHAIN_FOR_SYMBOL[params.token];
  const deployment = deploymentForSlug(params.token, chainSlug);
  const requiredChain = chainForSlug(chainSlug);
  const isStandard = params.mode === 'standard' || modeOverride === 'standard';
  const paymasterMode = resolvePaymasterMode(deployment);
  const isErc20Paymaster = !isStandard && paymasterMode === 'erc20';
  // JPYC ガス無料化: JPYC ガスレスは recover を除き常に無徴収 (relay free / 非 relay
  // sponsorship free のいずれも OpenPay が gas を全額負担)。USDC は従来どおり。
  const isJpyc = deployment.symbol === 'jpyc';
  const isMerchantGas = !isStandard && params.gas === 'merchant';

  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // JPYC ガスレスを EIP-3009 relay に倒すか (flag ON + JPYC + relay 対応 chain)。OFF / 非対応は
  // 'pimlico-7702' で従来挙動 (Pimlico fallback)。relay は smart account / gas quote 不要で、顧客が
  // 署名するだけ・自前 relayer がガス負担 (memory:jpyc-eip3009)。checkout は split 非対応なので
  // PaymentForm のような split ガードは要らない。
  const useRelay =
    !isStandard &&
    resolveJpycGaslessProvider(deployment, chainId ?? deployment.chainId) ===
      'eip3009-relay';
  const relay = useJpycEip3009Payment(deployment);
  // recover: forwarder 設定済 chain は gas 相当額を JPYC 回収 (gasMode で顧客上乗せ/店主吸収)。
  // 未設定は free (OpenPay 負担)。relayGasEquiv は回収する固定 gas 相当額 (free は 0)。
  const useRecover =
    useRelay && jpycForwarderFor(chainId ?? deployment.chainId) !== null;
  const relayGasEquiv = useRecover ? relayGasFeeValue() : 0n;

  // Smart Account / Pimlico 経路は gasless のみ必要 — standard / relay では skip。
  const { data: saData, error: saError } = useSmartAccount(
    deployment,
    !isStandard && !useRelay,
  );
  const gasless = useBatchPayment(deployment, !isStandard && !useRelay);
  const standard = useStandardPayment();
  const gasQuote = useGasQuote(deployment, !isStandard && !useRelay);
  // USDC ガスレスが Circle に解決される場合は surcharge 込み quote + permit allowance。
  const isCircle =
    !isStandard &&
    resolveUsdcGaslessProvider(deployment, deployment.chainId) === 'circle';
  const circleQuote = useGasQuoteCircle(deployment, !isStandard && isCircle);
  const activeQuote = isCircle ? circleQuote : gasQuote;
  const circlePermitAmount = isCircle ? circleQuote.data?.permitAmount : undefined;

  const totalWei = useMemo(
    () => calcCheckoutTotal(params.items, deployment.decimals),
    [params.items, deployment.decimals],
  );

  // standard mode では gasQuote 不要 (顧客 wallet が gas を自前で算定)。
  const gasAmount = !isStandard ? activeQuote.data?.gasAmount : undefined;
  // breakdown/会計に使う gas 相当額: relay は固定の回収額 (recover=fee / free=0)、非 relay は
  // paymaster quote。relay は quote を持たないため effective で切り替える (PaymentForm と同型)。
  const effectiveGasAmount: bigint | undefined = useRelay
    ? relayGasEquiv
    : isJpyc
      ? 0n
      : gasAmount;
  const effectiveMode = isStandard ? 'standard' : params.mode;
  const breakdown = useMemo(
    () =>
      calcBreakdown(
        totalWei,
        params.token,
        effectiveMode,
        params.gas,
        effectiveGasAmount ?? 0n,
      ),
    [totalWei, params.token, effectiveMode, params.gas, effectiveGasAmount],
  );

  const totalCustomerOutflow = breakdown.customerPays;
  // JPYC ガス無料化: JPYC は gas を一切徴収しないため 0 (OpenPay 全額負担)。mainnet USDC は
  // erc20 で 0、残る testnet USDC sponsorship fallback (非商用・非 JPYC) のみ従来どおり回収。
  const gasReimbursement =
    !isJpyc && !isCircle && paymasterMode === 'sponsorship'
      ? (gasAmount ?? 0n)
      : 0n;

  // 記録用ネットワーク手数料相当額 (会計分離・on-chain transfer とは別)。非 circle の
  // gasless 経路は gas 見積を計上 (JPYC relay=回収額/0 or sponsorship=立替回収 / USDC erc20=
  // paymaster 徴収分)。circle は receipt 由来の circlePaymasterNetUsdc を使うため null、standard は null。
  const networkFeeEquivalent =
    !isStandard && !isCircle ? (effectiveGasAmount ?? 0n) : null;
  const fmt = (wei: bigint) => formatTokenAmount(wei, deployment);

  // ネイティブガストークン symbol を viem chain 経由で取得 (chain-aware)。
  // Polygon=POL / Kaia=KAIA / Base/Arbitrum/Optimism=ETH。standard mode の
  // 顧客向け wallet hint + gasInfoJpyc / gasInfoUsdc tooltip で使用。
  const nativeToken = requiredChain.nativeCurrency.symbol;

  const { balance, insufficientBalance, wrongChain } = useErc20BalanceAndChain(
    deployment,
    requiredChain,
    totalCustomerOutflow,
  );

  const flowPending = isStandard
    ? standard.isPending
    : useRelay
      ? relay.isPending
      : gasless.isPending;
  // relay は gas quote も smart account も不要なので readiness は常に満たす。
  const gasQuoteReady = isStandard || useRelay || activeQuote.data !== undefined;
  // 運営の赤字防止: merchant が 0 になるケースは送信を block (fee>0 の Phase 2 で
  // 主に効く。fee=0 の現状で発火するのは gasless/merchant かつ total < gas のみ)。
  //   gasless / customer:  total < fee → merchant = 0
  //   gasless / merchant:  total < fee + gas → merchant = 0
  //   standard:            total < fee → merchant = 0
  // relay は固定 fee で見積待ちが無いので即判定可 (activeQuote ではなく useRelay で gate)。
  const merchantUnderflow =
    totalWei > 0n &&
    (isStandard || !isMerchantGas || useRelay || activeQuote.data !== undefined) &&
    breakdown.merchantReceives === 0n;
  const minimumAmountWei =
    breakdown.feeAmount + (isMerchantGas ? (effectiveGasAmount ?? 0n) : 0n);

  // relay が成功 or pending (broadcast 済) の後の再送信を禁止。再送すると新しい nonce で
  // 2 件目の authorization を出すことになり、元の tx が確定すると二重支払いになる。
  // revert (確定失敗で送金未成立) は安全なので再試行を許す (PaymentForm と同一防御)。
  const relaySettledNoRetry =
    useRelay && !!relay.data && (relay.data.success || !!relay.data.pending);

  const canSubmit =
    isConnected &&
    !wrongChain &&
    (isStandard || useRelay || !!saData) &&
    // PaymentForm と揃える明示ガード。現状は totalWei>0 (有効 items) 不変で merchantUnderflow
    // が拾うが、空 batch (merchant 受取 0) 送信を構造的にも塞ぐ defense-in-depth。
    breakdown.merchantReceives > 0n &&
    breakdown.customerPays > 0n &&
    !insufficientBalance &&
    !flowPending &&
    gasQuoteReady &&
    !merchantUnderflow &&
    !relaySettledNoRetry;

  const flowError = isStandard
    ? standard.error
    : useRelay
      ? relay.error
      : gasless.error;
  const saFallback =
    !isStandard && !useRelay && isIncompatibleSmartAccountError(saError);
  // 送信は成立したがチェーン上で revert したケース。gasless/relay は data.success===false、
  // standard は phase=*-error だが receipt 成功で Error 無し。無反応穴を明示メッセージで塞ぐ。
  const revertedNoFeedback =
    (!isStandard && !useRelay && !!gasless.data && !gasless.data.success) ||
    (useRelay && !!relay.data && !relay.data.success && !relay.data.pending) ||
    (isStandard &&
      (standard.isMerchantError || standard.isFeeError) &&
      !standard.error);
  // relay 経路の error は code 文字列 (rate_limited 等) なので friendly i18n に差し替える。
  const flowErrorMessage = useRelay
    ? flowError
      ? t(relayErrorKey(flowError))
      : undefined
    : flowError?.message;
  const error = isGasCongestedError(flowError)
    ? t('errorGasCongested')
    : (flowErrorMessage ??
      (isStandard || useRelay || saFallback ? undefined : saError?.message) ??
      (activeQuote.error ? t('errorGasQuote') : null) ??
      (merchantUnderflow
        ? t('errorMerchantUnderflow', { min: fmt(minimumAmountWei) })
        : null) ??
      (revertedNoFeedback ? t('errorReverted') : null));

  const [redirectIn, setRedirectIn] = useState<number | null>(null);
  // PayPay 風 大型成功 overlay。dismiss 後は inline 成功 panel + redirect countdown を表示。
  const [overlayDismissed, setOverlayDismissed] = useState(false);

  // R: gasQuote refetch (30s) で breakdown が再計算 → notification effect が再実行
  //    される。同一 tx hash の重複 webhook を防ぐため key 単位の dedup gate を使う。
  const notifiedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (gasless.error) logger.error('checkout.failed', { error: gasless.error });
  }, [gasless.error]);

  useEffect(() => {
    if (standard.error)
      logger.error('checkout.standard.failed', { error: standard.error });
  }, [standard.error]);

  useEffect(() => {
    if (saError) logger.error('checkout.smart-account.init-failed', { error: saError });
  }, [saError]);

  useEffect(() => {
    if (activeQuote.error) logger.error('checkout.gas-quote.failed', { error: activeQuote.error });
  }, [activeQuote.error]);

  useEffect(() => {
    if (relay.error) logger.error('checkout.relay.failed', { error: relay.error });
  }, [relay.error]);

  useEffect(() => {
    if (relay.data) {
      logger.info('checkout.relay.success', {
        txHash: relay.data.txHash,
        success: relay.data.success,
      });
    }
  }, [relay.data]);

  // mode 中立な決済結果ビュー: notification dedup key、webhook payload の hash field、
  // success_url query の (snake_case) hash field を 1 箇所に集約。
  const completion = useMemo(() => {
    if (isStandard && standard.data) {
      return {
        key: standard.data.merchantTxHash,
        mode: 'standard' as const,
        blockNumber: standard.data.blockNumber,
        hashFields: {
          merchantTxHash: standard.data.merchantTxHash,
          feeTxHash: standard.data.feeTxHash,
        },
        redirectQuery: {
          tx_hash: standard.data.merchantTxHash,
          ...(standard.data.feeTxHash
            ? { fee_tx_hash: standard.data.feeTxHash }
            : {}),
        },
      };
    }
    if (!isStandard && !useRelay && gasless.data?.success) {
      return {
        key: gasless.data.userOpHash,
        mode: 'gasless' as const,
        blockNumber: gasless.data.blockNumber as bigint | null,
        hashFields: {
          txHash: gasless.data.txHash,
          userOpHash: gasless.data.userOpHash,
        },
        redirectQuery: {
          tx_hash: gasless.data.txHash,
          user_op_hash: gasless.data.userOpHash,
        },
      };
    }
    // relay は txHash のみ (userOpHash / blockNumber 無し)。202 pending も txHash を持ちうるため
    // success を必須ガード (success を見ないと pending で webhook/redirect が誤発火する・Codex P1)。
    if (useRelay && relay.data?.success && relay.data.txHash) {
      return {
        key: relay.data.txHash,
        mode: 'gasless' as const,
        blockNumber: null as bigint | null,
        hashFields: { txHash: relay.data.txHash },
        redirectQuery: { tx_hash: relay.data.txHash },
      };
    }
    return null;
  }, [isStandard, useRelay, gasless.data, standard.data, relay.data]);

  useEffect(() => {
    if (!completion) return;
    if (notifiedKeyRef.current === completion.key) return;
    notifiedKeyRef.current = completion.key;

    logger.info('checkout.success', {
      mode: completion.mode,
      ...completion.hashFields,
      merchant: params.to,
      orderId: params.orderId,
      token: params.token,
      chain: chainSlug,
    });

    // webhook 失敗 (CORS 等) は logger.warn のみ。決済自体は成立しているため UI には出さない。
    if (params.webhook) {
      const payload = {
        type: 'openpay.checkout.success',
        mode: completion.mode,
        merchant: params.to,
        from: address,
        token: params.token,
        chain: chainSlug,
        chainId: deployment.chainId,
        amount: formatUnits(totalWei, deployment.decimals),
        items: params.items,
        merchantAmount: breakdown.merchantReceives.toString(),
        feeAmount: breakdown.feeAmount.toString(),
        customerPays: breakdown.customerPays.toString(),
        orderId: params.orderId,
        description: params.description,
        customerEmail: params.customerEmail,
        ...completion.hashFields,
        // relay は block 不明 (txHash のみ)。null のときは payload から省略する
        // (下流 consumer が missing と null を区別するため・"null" 文字列にしない)。
        ...(completion.blockNumber !== null
          ? { blockNumber: completion.blockNumber.toString() }
          : {}),
        ts: Date.now(),
      };
      fetch(params.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        mode: 'cors',
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok) {
            logger.warn('checkout.webhook.non_ok', {
              status: res.status,
              statusText: res.statusText,
              url: params.webhook,
            });
          }
        })
        .catch((err) =>
          logger.warn('checkout.webhook.failed', {
            error: err,
            url: params.webhook,
          }),
        );
    }

    if (params.successUrl) {
      setRedirectIn(SUCCESS_REDIRECT_DELAY_MS / 1000);
    }
  }, [
    completion,
    params.to,
    params.token,
    chainSlug,
    params.items,
    params.orderId,
    params.description,
    params.customerEmail,
    params.webhook,
    params.successUrl,
    address,
    breakdown.merchantReceives,
    breakdown.feeAmount,
    breakdown.customerPays,
    deployment.chainId,
    deployment.decimals,
    totalWei,
  ]);

  // ローカル履歴 (Phase 2) — gasless / standard 全 5 transition を hook で集約。
  // note には description (なければ orderId) を入れ、CSV/UI で会計補助情報に使う。
  // v5: itemized checkout の items を売上明細 (lineItems) として保存し、税/管理番号も記録。
  // productName は明細名の連結 (buildHistoryEntry で 80 文字 cap)、memo は description。
  const historyCtx = useMemo(
    () => ({
      chainId: deployment.chainId,
      chainSlug,
      asset: params.token,
      tokenAddress: deployment.address,
      payMode: isStandard ? ('standard' as const) : ('gasless' as const),
      gasMode: isStandard ? null : params.gas,
      merchant: params.to,
      merchantAmount: breakdown.merchantReceives,
      customer: address,
      feeReceiver: env.feeReceiver,
      feeAmount: breakdown.feeAmount,
      saleAmount: totalWei,
      networkFeeEquivalent,
      storeName: '',
      note: params.description ?? params.orderId ?? '',
      productName: params.items.map((it) => it.name).join(', '),
      memo: params.description ?? null,
      taxRate: params.taxRate ?? null,
      taxCategory: params.taxCategory ?? null,
      receiptNo: params.receiptNo ?? null,
      lineItems: params.items.map((it, i) => {
        // amount = price × qty を人間可読 decimal で (raw wei ではない)。
        const amount = formatUnits(
          calcCheckoutTotal([it], deployment.decimals),
          deployment.decimals,
        );
        // per-item 税を優先 (混在税率カート)、無ければ checkout 単位 (単一税率) に fallback。
        const taxRate = it.taxRate ?? params.taxRate ?? null;
        const taxCategory = it.taxCategory ?? params.taxCategory ?? null;
        const taxAmt = taxAmountDecimal(
          Number(amount),
          taxRate,
          taxDisplayDecimals(params.token),
        );
        return {
          id: String(i),
          name: it.name,
          quantity: it.qty,
          unitPrice: it.price,
          amount,
          currency: params.token,
          taxRate,
          taxCategory,
          taxAmount: taxAmt == null ? '0' : String(taxAmt),
          memo: it.memo ?? null,
        };
      }),
      // 顧客向け電子レシート (PayerReceipt) の発生元 / 表示 locale。
      sourceRoute: '/checkout',
      locale,
    }),
    [
      deployment.chainId,
      deployment.address,
      deployment.decimals,
      chainSlug,
      params.token,
      params.gas,
      params.to,
      params.description,
      params.orderId,
      params.items,
      params.taxRate,
      params.taxCategory,
      params.receiptNo,
      isStandard,
      breakdown.merchantReceives,
      breakdown.feeAmount,
      totalWei,
      networkFeeEquivalent,
      address,
      locale,
    ],
  );
  // relay 成功/失敗/pending を既存の gasless 履歴経路に流す合成 snapshot。relay は userOp/receipt
  // block を持たないため両者 null。amount は mutate() の variables で固定し drift を避ける。
  // recover は hook と同一式で split を再計算: feeAmount(=サービス料) は常に 0、ネットワーク手数料
  // 相当額 = 回収した gas (feeValue)、merchantAmount は customer 上乗せなら満額・merchant 吸収なら
  // 満額−fee、saleAmount は請求額 (value)。free は fee=0・netFee=0。pending は status='pending'。
  const relayHistoryGasless = useRelayGaslessSnapshot(relay, useRecover);
  usePaymentHistory(
    historyCtx,
    useRelay ? relayHistoryGasless : gasless,
    standard,
  );

  useEffect(() => {
    if (redirectIn === null) return;
    if (redirectIn <= 0) {
      doRedirect();
      return;
    }
    const id = setTimeout(() => setRedirectIn((v) => (v === null ? null : v - 1)), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doRedirect は意図的に除外 (含めると毎 render でタイマーがリセットされる)
  }, [redirectIn]);

  function doRedirect() {
    if (!params.successUrl || !completion) return;
    const u = new URL(params.successUrl);
    for (const [k, v] of Object.entries(completion.redirectQuery)) {
      u.searchParams.set(k, v);
    }
    // relay は block 不明 — 値があるときだけ付与 (redirectQuery も relay は tx_hash のみ)。
    if (completion.blockNumber !== null) {
      u.searchParams.set('block', completion.blockNumber.toString());
    }
    if (params.orderId) u.searchParams.set('order_id', params.orderId);
    u.searchParams.set('chain', chainSlug);
    u.searchParams.set('token', params.token);
    u.searchParams.set('mode', completion.mode);
    setRedirectIn(null);
    // Next.js の router は同一オリジンのみ。success_url は外部 URL なので window.location.assign。
    window.location.assign(u.toString());
  }

  function onSubmit() {
    if (!canSubmit) return;
    // 完了画面のチャイムを iOS でも鳴らせるよう、この gesture 内で AudioContext を解錠。
    primeChimeAudio();
    if (isStandard) {
      standard.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
        chainId: deployment.chainId,
      });
    } else if (useRelay) {
      // JPYC EIP-3009 relay: 顧客が transferWithAuthorization に署名 → 自前 relayer が gas 負担で
      // submit。fee=0・gas は OpenPay 肩代わり (free) or JPYC 回収 (recover・hook 内で分割)。
      // 全額 (totalWei) をそのまま relay に渡す (recover の控除は hook 側)。
      relay.mutate({ merchant: params.to, value: totalWei, gasMode: params.gas });
    } else {
      gasless.mutate({
        tokenAddress: deployment.address,
        merchant: params.to,
        merchantAmount: breakdown.merchantReceives,
        feeReceiver: env.feeReceiver,
        feeAmount: breakdown.feeAmount,
        gasReimbursement,
        saleAmount: totalWei,
        networkFeeEquivalent: networkFeeEquivalent ?? undefined,
        circlePermitAmount,
      });
    }
  }

  const explorerBase = blockExplorerUrl(deployment.chainId);
  const approvalCheckUrl =
    isErc20Paymaster && address && explorerBase
      ? `${explorerBase}/tokenapprovalchecker?search=${address}`
      : undefined;

  const completed = isStandard
    ? !!standard.data
    : useRelay
      ? !!(relay.data && relay.data.success)
      : !!(gasless.data && gasless.data.success);

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs uppercase tracking-wider text-slate-500">
          {t('header')}
        </p>
        <p className="mt-1 text-base font-semibold text-slate-800">
          {params.orderId ? t('orderHeading', { id: params.orderId }) : t('checkoutTitle')}
        </p>
        {params.description && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">
            {params.description}
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          {t('payToLabel', { addr: shortAddress(params.to) })} ·{' '}
          {requiredChain.name} · {deployment.displaySymbol} ·{' '}
          {isStandard ? t('modeBadgeStandard') : t('modeBadgeGasless')}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('itemsTitle')}
        </p>
        <ul className="mt-3 divide-y divide-slate-100">
          {params.items.map((it, i) => {
            const lineTotalWei = calcCheckoutTotal([it], deployment.decimals);
            return (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 flex-1 break-words font-medium text-slate-700">
                  {it.name}
                </span>
                <span className="shrink-0 font-mono text-xs text-slate-500">
                  ×{it.qty}
                </span>
                <span className="shrink-0 font-mono text-sm text-slate-800">
                  {fmt(lineTotalWei)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 border-t border-slate-200 pt-3">
          <dl className="space-y-1.5">
            <Row label={t('subtotalRow')} value={fmt(totalWei)} />
            {/* fee=0 のとき手数料行は非表示 (Phase 1 alpha)。 */}
            {breakdown.feeAmount > 0n && (
              <Row label={t('feeRow')} value={fmt(breakdown.feeAmount)} />
            )}
            {isStandard ? (
              <Row label={t('gasRowStandard')} value={t('gasRowStandardValue')} />
            ) : useRecover ? (
              <Row
                label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
                labelExtra={<InfoTooltip text={t('gasInfoJpycRecover')} />}
                value={fmt(relayGasEquiv)}
              />
            ) : useRelay || isJpyc ? (
              // JPYC ガスレス (relay free / 非 relay sponsorship free) は無徴収。中立ラベル。
              <Row
                label={t('gasRowFree')}
                labelExtra={<InfoTooltip text={t('gasInfoJpycRelay')} />}
                value={t('gasRowRelayFree')}
              />
            ) : (
              <Row
                label={isMerchantGas ? t('gasRowMerchant') : t('gasRow')}
                labelExtra={
                  <InfoTooltip
                    text={
                      isCircle
                        ? t('gasInfoUsdcCircle', { nativeToken })
                        : isErc20Paymaster
                          ? t('gasInfoUsdc', { nativeToken })
                          : t('gasInfoJpyc', { nativeToken })
                    }
                  />
                }
                value={
                  gasAmount !== undefined
                    ? t('gasRowValue', { amount: fmt(gasAmount) })
                    : t('gasRowPending')
                }
              />
            )}
            <div className="my-1 border-t border-slate-200" />
            <Row
              label={
                isStandard
                  ? t('totalRowStandard', { nativeToken })
                  : isMerchantGas
                    ? t('totalRowMerchantGas')
                    : t('totalRow')
              }
              value={fmt(totalCustomerOutflow)}
              strong
            />
          </dl>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {isStandard
            ? t('standardHint', { nativeToken })
            : useRecover
              ? t('gaslessHintJpycRecover')
              : useRelay || isJpyc
                ? t('gaslessHintJpycRelay')
                : isErc20Paymaster
                  ? t('gaslessHintUsdc')
                  : t('gaslessHintJpyc')}
        </p>
        {approvalCheckUrl && (
          <p className="mt-2 text-[11px]">
            <a
              href={approvalCheckUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-slate-500 underline hover:text-slate-700"
            >
              {t('approvalCheckLink')} ↗
            </a>
          </p>
        )}
      </section>

      {saFallback && (
        <SmartAccountFallbackBanner
          delegateAddress={saError.delegateAddress}
          nativeToken={nativeToken}
          reason={
            saError.i18nKey === 'errorPristineNoBootstrap'
              ? 'pristine'
              : 'incompatible'
          }
          canFallbackToStandard
          onSwitchToStandard={() => setModeOverride('standard')}
        />
      )}

      {!completed && (
        <section className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('walletSection')}
          </p>
          <ConnectButton />

          {isConnected && wrongChain && (
            <button
              type="button"
              onClick={() => switchChain({ chainId: requiredChain.id })}
              disabled={isSwitching}
              className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {isSwitching
                ? t('switchingChain')
                : t('switchChain', { chainName: requiredChain.name })}
            </button>
          )}

          {isConnected && !wrongChain && balance !== undefined && (
            <p className="text-xs text-slate-500">
              {t('balanceLabel')}{' '}
              <span className="font-mono">{fmt(balance)}</span>
            </p>
          )}

          {insufficientBalance && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <p>
                {t('insufficientBalance', {
                  amount: fmt(totalCustomerOutflow),
                })}
              </p>
              <OnrampCta token={params.token} namespace="CheckoutForm" />
            </div>
          )}

          {params.customerEmail && (
            <p className="text-[11px] text-slate-500">
              {t('emailHint', { email: params.customerEmail })}
            </p>
          )}
        </section>
      )}

      {!completed && (
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="w-full rounded-xl bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {flowPending
            ? isStandard
              ? checkoutPhaseLabel(standard.phase, t)
              : t('btnSending')
            : !isConnected
              ? t('btnConnect')
              : wrongChain
                ? t('btnSwitchChain')
                : !isStandard && !useRelay && !saData
                  ? t('btnSaInit')
                  : !gasQuoteReady
                    ? t('btnGasQuoteLoading')
                    : t('btnPay', { amount: fmt(totalCustomerOutflow) })}
        </button>
      )}

      {/* standard モードで fee tx だけ失敗した場合の retry UI (merchant 確定済)。 */}
      {!completed && isStandard && standard.isFeeError && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">{t('standardFeeRetryTitle')}</p>
          <p className="text-xs">{t('standardFeeRetryBody')}</p>
          <button
            type="button"
            onClick={() => standard.retryFee()}
            className="w-full rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
          >
            {t('standardFeeRetryButton')}
          </button>
        </div>
      )}

      {!completed && params.cancelUrl && (
        <a
          href={params.cancelUrl}
          className="block text-center text-xs text-slate-500 underline hover:text-slate-700"
        >
          {t('cancelLink')}
        </a>
      )}

      {error && !completed && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <p className="font-semibold">{t('errorTitle')}</p>
          <p className="mt-1 break-words">{error}</p>
        </div>
      )}

      {completed && (gasless.data || standard.data || relay.data) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-semibold">{t('successTitle')}</p>
          <p className="mt-1 text-xs">{t('successBody')}</p>
          <dl className="mt-3 space-y-1 text-xs">
            {!isStandard && !useRelay && gasless.data && (
              <>
                <ResultRow
                  label={t('successUserOp')}
                  value={gasless.data.userOpHash}
                  copyable
                />
                <ResultRow
                  label={t('successTx')}
                  value={gasless.data.txHash}
                  copyable
                />
                <ResultRow
                  label={t('successBlock')}
                  value={gasless.data.blockNumber.toString()}
                />
              </>
            )}
            {/* relay は userOp/block を持たないため Tx Hash のみ表示 (Explorer は overlay 側)。 */}
            {useRelay && relay.data?.success && relay.data.txHash && (
              <ResultRow
                label={t('successTx')}
                value={relay.data.txHash}
                copyable
              />
            )}
            {isStandard && standard.data && (
              <>
                <ResultRow
                  label={t('standardMerchantTxLabel')}
                  value={standard.data.merchantTxHash}
                  copyable
                />
                {standard.data.feeTxHash && (
                  <ResultRow
                    label={t('standardFeeTxLabel')}
                    value={standard.data.feeTxHash}
                    copyable
                  />
                )}
                <ResultRow
                  label={t('successBlock')}
                  value={standard.data.blockNumber.toString()}
                />
              </>
            )}
            {params.orderId && (
              <ResultRow label={t('orderIdLabel')} value={params.orderId} />
            )}
          </dl>

          {/* 顧客向け電子レシート (支払い控え) を完了画面にも埋め込む。 */}
          <div className="mt-4">
            <PayerReceiptCompletion
              candidateIds={[
                standard.data?.merchantTxHash,
                gasless.data?.txHash,
                gasless.data?.userOpHash,
                relay.data?.txHash ?? undefined,
              ]}
            />
          </div>

          {params.successUrl && (
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs">
                {redirectIn !== null && redirectIn > 0
                  ? t('redirectingIn', { sec: redirectIn })
                  : t('redirectingNow')}
              </p>
              <button
                type="button"
                onClick={doRedirect}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                {t('redirectNowButton')}
              </button>
            </div>
          )}
          {!params.successUrl && (
            <button
              type="button"
              onClick={() => router.push('/')}
              className="mt-4 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              {t('returnHomeButton')}
            </button>
          )}
        </div>
      )}

      {/* relay pending: broadcast 済だが未確定。standard へ fallback させず「確認待ち」を表示
          (再送信は canSubmit の relaySettledNoRetry で禁止)。txHash があれば Explorer で追跡。 */}
      {useRelay && relay.data?.pending && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
          <p className="font-semibold">{t('pendingTitle')}</p>
          <p className="mt-1 break-words">{t('pendingBody')}</p>
          {relay.data.txHash && (
            <p className="mt-2 break-all font-mono text-xs">
              {relay.data.txHash}
              {explorerBase && (
                <>
                  {' · '}
                  <a
                    href={`${explorerBase}/tx/${relay.data.txHash}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-sans underline hover:text-sky-900"
                  >
                    {t('pendingExplorerLink')} ↗
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}

      <p className="pt-2 text-center text-[10px] text-slate-400">
        {t('poweredBy')}{' '}
        <a
          href="https://github.com/cipherwebllc/openpay"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-slate-600"
        >
          OpenPay
        </a>
      </p>

      {/* PayPay 風 大型成功 overlay。dismiss 後は inline panel + redirect countdown を表示。
          success_url 指定時は overlay 表示中も 3 秒 countdown が並走する仕様。 */}
      {!overlayDismissed && completed && !isStandard && !useRelay && gasless.data && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={gasless.data.txHash}
          userOpHash={gasless.data.userOpHash}
          blockNumber={gasless.data.blockNumber}
          explorerBase={explorerBase}
          merchantAddress={params.to}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}
      {/* relay は userOp/block 無し → txHash のみで overlay を出す。 */}
      {!overlayDismissed &&
        completed &&
        useRelay &&
        relay.data?.success &&
        relay.data.txHash && (
          <SuccessOverlay
            amountDisplay={fmt(totalCustomerOutflow)}
            txHash={relay.data.txHash}
            explorerBase={explorerBase}
            merchantAddress={params.to}
            onDismiss={() => setOverlayDismissed(true)}
          />
        )}
      {!overlayDismissed && completed && isStandard && standard.data && (
        <SuccessOverlay
          amountDisplay={fmt(totalCustomerOutflow)}
          txHash={standard.data.merchantTxHash}
          blockNumber={standard.data.blockNumber}
          explorerBase={explorerBase}
          merchantAddress={params.to}
          onDismiss={() => setOverlayDismissed(true)}
        />
      )}
    </div>
  );
}

function checkoutPhaseLabel(
  phase: ReturnType<typeof useStandardPayment>['phase'],
  t: ReturnType<typeof useTranslations<'CheckoutForm'>>,
): string {
  switch (phase) {
    case 'merchant-sending':
      return t('btnStandardMerchantSending');
    case 'merchant-mining':
      return t('btnStandardMerchantMining');
    case 'fee-sending':
      return t('btnStandardFeeSending');
    case 'fee-mining':
      return t('btnStandardFeeMining');
    default:
      return t('btnSending');
  }
}

