'use client';

// CrossChainHint — PaymentForm の augmentation panel。
//
// 機能:
//   - buyer が target chain で balance 不足 (= direct path 不可) のとき、
//     Gateway / CCTP V2 で別 chain から支払える代替経路を提示
//   - 「Use this cross-chain path」button で実行 (sign + bridge + mint)
//   - direct path 可能 / amount 0 / token != usdc / crossChain=false なら非表示
//
// 設計判断:
//   - 既存の Pay button / breakdown は touch しない (augmentation のみ)
//   - decision.path が 'direct' なら何も出さず透過 (UX 上余計な選択肢を増やさない)
//   - decision.path が 'onramp' (balance なし) も非表示 (既存 OnrampCta が拾う)
//   - useCrossChainPayment を内部で 1 度だけ呼び、execute まで担当

import { useEffect } from 'react';
import { formatUnits, type Address } from 'viem';
import { useTranslations } from 'next-intl';
import { useCrossChainPayment } from '@/hooks/useCrossChainPayment';
import {
  buildPaymentLogEvent,
  logPaymentEvent,
  type PaymentBridge,
} from '@/lib/paymentLog';
import type { CrossChainProgress } from '@/lib/crossChain/execute';
import type { PathDecision } from '@/lib/crossChain/router';
import { blockExplorerUrl } from '@/lib/chains';
import { shortAddress } from '@/lib/format';
import { logger } from '@/lib/logger';

export interface CrossChainHintProps {
  /** PaymentForm の token (token !== 'usdc' なら hint を出さない) */
  token: 'usdc' | 'jpyc';
  /** crossChain が許可されているか (URL の crossChain flag) */
  enabled: boolean;
  /** merchant 受取 chain id */
  targetChainId: number;
  /** merchant 受取 address */
  recipient: Address;
  /** customer が支払う atomic 額 (PaymentForm の totalCustomerOutflow と一致) */
  requiredAtomic: bigint;
  /** USDC decimals (= 6)。表示で formatUnits に使う */
  displayDecimals: number;
  /** USDC token address (paymentLog 用) */
  tokenAddress: Address;
}

export function CrossChainHint(props: CrossChainHintProps) {
  const t = useTranslations('CrossChainHint');
  // hook は常に呼ぶ (条件付きフック禁止)、enabled=false でも react-query が
  // skip するため API call は発火しない。
  const hook = useCrossChainPayment({
    targetChainId: props.targetChainId,
    requiredAtomic: props.requiredAtomic,
    recipient: props.recipient,
    enabled:
      props.token === 'usdc' && props.enabled && props.requiredAtomic > 0n,
  });
  const { decision, progress, isExecuting, result, error } = hook;

  // Sentry observability: success / failure / balance query 失敗 を logger 経由で
  // 集計 (production で cross-chain UX の信頼性監視 + Pimlico 残高との突合)。
  // useEffect は早期 return 前に呼ぶ (React rules of hooks 準拠)。result/error
  // が undefined のときは内部で if guard、Hint 自体が出ない条件でも logger は
  // 触らないので副作用は発生しない。
  useEffect(() => {
    if (result) {
      logger.info('cross-chain.execute.success', {
        bridge: result.path,
        destChainId: result.destChainId,
        mintTxHash: result.mintTxHash,
        recipient: props.recipient,
        valueAtomic: props.requiredAtomic.toString(),
      });
    }
  }, [result, props.recipient, props.requiredAtomic]);

  useEffect(() => {
    if (error) {
      logger.error('cross-chain.execute.failed', {
        error,
        targetChainId: props.targetChainId,
        valueAtomic: props.requiredAtomic.toString(),
        decisionPath: decision?.path,
      });
    }
  }, [error, props.targetChainId, props.requiredAtomic, decision?.path]);

  useEffect(() => {
    if (hook.balancesError) {
      logger.warn('cross-chain.balance-query.failed', {
        error: hook.balancesError,
        targetChainId: props.targetChainId,
      });
    }
  }, [hook.balancesError, props.targetChainId]);

  if (
    props.token !== 'usdc' ||
    !props.enabled ||
    props.requiredAtomic <= 0n
  ) {
    return null;
  }

  if (!decision) {
    if (hook.isFetchingBalances) {
      return (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
          {t('balancesLoading')}
        </p>
      );
    }
    return null;
  }

  if (decision.path === 'direct' || decision.path === 'onramp') return null;

  if (result) {
    const explorer = blockExplorerUrl(result.destChainId);
    return (
      <SuccessPanel
        bridge={result.path}
        recipient={props.recipient}
        valueAtomic={props.requiredAtomic}
        displayDecimals={props.displayDecimals}
        destChainId={result.destChainId}
        mintTxHash={result.mintTxHash}
        explorerBase={explorer}
      />
    );
  }

  const bridge: PaymentBridge =
    decision.path === 'gateway' ? 'gateway' : 'cctp-v2';
  const bridgeLabel = t(bridge === 'gateway' ? 'bridgeGateway' : 'bridgeCctp');

  // closure に narrow 済 decision を capture (closure 内で再 narrow すると
  // TS18048 で undefined 推論される)
  const decisionForLog = decision;
  const sourceChainIdForLog =
    decisionForLog.path === 'cctp-v2'
      ? decisionForLog.sourceChainId
      : undefined;
  async function onClick() {
    // hook.execute は失敗時 throw するが error state にも記録されるため、
    // ここで catch して unhandled rejection 警告を抑制 (UI は useEffect で
    // hook.error を観測して error panel + Sentry log を出す)。
    let executeResult;
    try {
      executeResult = await hook.execute();
    } catch {
      return;
    }
    if (executeResult) {
      const evt = buildPaymentLogEvent(
        {
          flow: 'direct',
          chainId: props.targetChainId,
          tokenAddress: props.tokenAddress,
          merchant: props.recipient,
          merchantAmount: props.requiredAtomic,
          bridge,
          sourceChainId: sourceChainIdForLog,
        },
        { result: 'success', txHash: executeResult.mintTxHash },
      );
      void logPaymentEvent(evt);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold text-sky-900">
          {t('alternativeAvailable', { bridge: bridgeLabel })}
        </p>
        <span className="rounded-full bg-sky-100 px-2 py-0.5 font-mono text-[10px] uppercase text-sky-700">
          {bridge}
        </span>
      </div>
      <p className="text-xs text-sky-800">{describePath(decision, t)}</p>
      <p className="text-xs text-sky-700">
        {t('amount', {
          value: formatUnits(props.requiredAtomic, props.displayDecimals),
        })}
      </p>
      <button
        type="button"
        onClick={onClick}
        disabled={isExecuting}
        className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
      >
        {isExecuting
          ? `${t('inProgress')}${progress ? ` — ${formatProgress(progress, t)}` : ''}`
          : t('payWithCrossChain', { bridge: bridgeLabel })}
      </button>
      {error && (
        <p className="text-xs text-red-700">
          {t('errorPrefix')}: {error.message}
        </p>
      )}
    </div>
  );
}

function describePath(
  decision: PathDecision,
  t: ReturnType<typeof useTranslations>,
): string {
  if (decision.path === 'gateway') {
    return t('describeGateway', {
      sourceDomain: decision.sourceDomain,
      destDomain: decision.destinationDomain,
    });
  }
  if (decision.path === 'cctp-v2') {
    return t('describeCctp', {
      sourceChainId: decision.sourceChainId,
      destChainId: decision.targetChainId,
    });
  }
  // direct / onramp はこの関数を呼ばない (caller でガード済み)
  return '';
}

function formatProgress(
  p: CrossChainProgress,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (p.kind) {
    case 'sign':
      return t('progressSign');
    case 'attest':
      return t('progressAttest');
    case 'switch_chain':
      return t('progressSwitchChain', { chainId: p.targetChainId });
    case 'approve':
      return t('progressApprove');
    case 'source_tx_pending':
      return t('progressSourceTxPending');
    case 'poll_attestation':
      return t('progressPollAttestation');
    case 'dest_tx_pending':
      return t('progressDestTxPending');
  }
}

function SuccessPanel({
  bridge,
  recipient,
  valueAtomic,
  displayDecimals,
  destChainId,
  mintTxHash,
  explorerBase,
}: {
  bridge: 'gateway' | 'cctp-v2';
  recipient: Address;
  valueAtomic: bigint;
  displayDecimals: number;
  destChainId: number;
  mintTxHash: `0x${string}`;
  explorerBase: string | undefined;
}) {
  const t = useTranslations('CrossChainHint');
  return (
    <div className="space-y-1 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
      <p className="font-semibold text-emerald-900">
        {t('successTitle', {
          bridge: t(bridge === 'gateway' ? 'bridgeGateway' : 'bridgeCctp'),
        })}
      </p>
      <p className="text-xs text-emerald-800">
        {t('successDescription', {
          amount: formatUnits(valueAtomic, displayDecimals),
          recipient: shortAddress(recipient),
          chainId: destChainId,
        })}
      </p>
      {explorerBase && (
        <a
          href={`${explorerBase}/tx/${mintTxHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-emerald-700 underline"
        >
          {t('viewOnExplorer')}
        </a>
      )}
    </div>
  );
}
