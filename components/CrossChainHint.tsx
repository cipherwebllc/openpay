'use client';

// CrossChainHint — PaymentForm の augmentation panel。
// direct path 可能 / amount 0 / token != usdc / crossChain=false なら非表示
// (= 既存 Pay button / OnrampCta に委譲)。cross-chain options が 1 件以上ある時に
// CrossChainSourceChooser を表示、user 選択で executeOption を呼ぶ。
//
// phase 4b-1.7 リファクタ: 旧 UI は auto-decision 1 経路を提示するだけだったが、
// buyer が複数 chain (Avalanche / Polygon / Base 等) に USDC を持つケースで
// 「能動的 source 選択 + per-chain fee 内訳」を提供する。direct path は
// chooser に含めるが、既存の direct 経路 (useBatchPayment / useStandardPayment)
// に委譲するため execute は no-op (= 既存 Pay button が処理する)。

import { useEffect, useState } from 'react';
import { formatUnits, type Address } from 'viem';
import { useTranslations } from 'next-intl';
import { useCrossChainPayment } from '@/hooks/useCrossChainPayment';
import {
  buildPaymentLogEvent,
  logPaymentEvent,
  type PaymentBridge,
} from '@/lib/paymentLog';
import type { CrossChainProgress } from '@/lib/crossChain/execute';
import type { PathOption } from '@/lib/crossChain/pathEnumerator';
import { computeCrossChainFeeSplit } from '@/lib/crossChain/feeSplit';
import { CROSS_CHAIN_DISABLED } from '@/lib/crossChain/config';
import { blockExplorerUrl } from '@/lib/chains';
import { CrossChainSourceChooser } from './CrossChainSourceChooser';
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
  /** 請求額 (invoice amount, atomic)。Phase 1 では feeAmount = 0 なので merchant
   *  宛 1 本のみブリッジ (顧客が source USDC でこの額を支出)。ネットワークガスは
   *  native (ETH/POL) 別途負担なので USDC 額には含めない。 */
  requiredAtomic: bigint;
  /** OpenPay 利用料の送り先 (operator)。Phase 1 では feeAmount = 0 のため使われない
   *  が、Phase 2 復活時の宛先として env から渡し続ける。 */
  feeReceiver: Address;
  /** USDC decimals (= 6)。表示で formatUnits に使う */
  displayDecimals: number;
  /** USDC token address (paymentLog 用) */
  tokenAddress: Address;
  /** 同一チェーンの直接送金がガスレスか (= ガスレス決済モードで paymaster が効く)。
   *  cross-chain (Gateway/CCTP) は常にガス顧客負担なので chooser で「直接送金=ガスレス /
   *  cross-chain=ガス代要」を出し分けるために使う。standard モードや paymaster 無効時は
   *  false (直接送金もガス顧客負担)。 */
  directIsGasless: boolean;
}

export function CrossChainHint(props: CrossChainHintProps) {
  const t = useTranslations('CrossChainHint');
  // hook は常に呼ぶ (条件付きフック禁止)、enabled=false で react-query が skip。
  // CROSS_CHAIN_DISABLED env が ON のときは incident response として hook 全停止。
  const hook = useCrossChainPayment({
    targetChainId: props.targetChainId,
    requiredAtomic: props.requiredAtomic,
    recipient: props.recipient,
    feeReceiver: props.feeReceiver,
    enabled:
      !CROSS_CHAIN_DISABLED &&
      props.token === 'usdc' &&
      props.enabled &&
      props.requiredAtomic > 0n,
  });
  const { decision, pathOptions, progress, isExecuting, result, error } = hook;
  // user 選択 state。default = options[0] (auto-best、enumerator は direct →
  // gateway → cctp-v2 / balance 降順で sort 済)。options 変化に追従するため
  // useEffect で再同期。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    if (pathOptions.length === 0) {
      setSelectedKey(null);
      return;
    }
    // 現選択が options から消えた場合のみ再 default。既選択が残っていれば維持。
    setSelectedKey((cur) => {
      if (cur && pathOptions.some((o) => o.key === cur)) return cur;
      return pathOptions[0].key;
    });
  }, [pathOptions]);
  const selectedOption =
    pathOptions.find((o) => o.key === selectedKey) ?? null;

  // Sentry observability。useEffect は早期 return 前に呼ぶ必要があるため
  // (React rules of hooks)、内部 if guard で空 trigger を抑止する。
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
    CROSS_CHAIN_DISABLED ||
    props.token !== 'usdc' ||
    !props.enabled ||
    props.requiredAtomic <= 0n
  ) {
    return null;
  }

  // 成功 panel は path 完了時のみ。
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

  // balance fetch 中 (decision 未確定 = options も未) は loading hint。
  if (!decision && hook.isFetchingBalances) {
    return (
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        {t('balancesLoading')}
      </p>
    );
  }

  // options なし or decision が onramp のみ (= どの chain にも balance なし)
  // は何も出さず OnrampCta (PaymentForm 側) に委譲。
  if (pathOptions.length === 0) return null;
  if (decision?.path === 'onramp') return null;

  // direct のみで cross-chain option なし → 既存 Pay button に完全委譲、本 panel 非表示。
  // (chooser 表示しても direct 1 件しか出ず情報価値ゼロ、UI スペース節約)
  const hasCrossChain = pathOptions.some((o) => o.kind !== 'direct');
  if (!hasCrossChain) return null;

  async function onPay() {
    if (!selectedOption) return;
    // direct option は既存 Pay button に委譲 (UX 上 chooser からも実行できる
    // 方が一貫性あるが、execute path が違う = useBatchPayment / useStandardPayment
    // を経由する必要があるため、本 panel では NOTE 表示 + 親 Pay button に
    // 誘導する。)
    if (selectedOption.kind === 'direct') {
      // user 操作で direct を選んだが、本 panel は cross-chain 実行 hook 限定。
      // 親 PaymentForm の Pay button を案内する text は UI 上に常時表示しているので
      // ここでは何もしない (= no-op、panel 残る)。
      return;
    }
    let executeResult;
    try {
      executeResult = await hook.executeOption(selectedOption);
    } catch {
      return;
    }
    if (executeResult) {
      const bridge: PaymentBridge =
        selectedOption.kind === 'gateway' ? 'gateway' : 'cctp-v2';
      const sourceChainIdForLog =
        selectedOption.kind === 'cctp-v2'
          ? selectedOption.sourceChainId
          : undefined;
      // Phase 1 (alpha): FEE_BPS_* = 0n のため feeAmount = 0、bridgedAmount =
      // amount となり、cross-chain は merchant 宛 1 本のみブリッジ。Phase 2 で
      // 課金復活時は同経路で feeAmount > 0 になり、operator 宛 2 本目のブリッジが
      // 自動で復活する (execute 側の bridgeFee guard 経由)。
      const { feeAmount, bridgedAmount } = computeCrossChainFeeSplit(
        props.requiredAtomic,
        'usdc',
        'standard',
      );
      const evt = buildPaymentLogEvent(
        {
          flow: 'direct',
          chainId: props.targetChainId,
          tokenAddress: props.tokenAddress,
          merchant: props.recipient,
          merchantAmount: bridgedAmount,
          feeReceiver: props.feeReceiver,
          feeAmount,
          // 利用料は merchant mint とは別 tx で着金する。監査用に fee mint hash を
          // 記録 (txHash は merchant mint なので、これが無いと fee 送金を辿れない)。
          feeTxHash: executeResult.feeMintTxHash,
          bridge,
          sourceChainId: sourceChainIdForLog,
        },
        { result: 'success', txHash: executeResult.mintTxHash },
      );
      void logPaymentEvent(evt);
    }
  }

  const isDirectSelected = selectedOption?.kind === 'direct';
  const payButtonDisabled = isExecuting || !selectedOption || isDirectSelected;
  // 中断再開: 選択中 option に保存済みの途中 state があれば、再 Pay で続きから
  // 再開できる (送金済みは再送しない)。UI で明示して二重支払いの不安を消す。
  const resumable =
    !isDirectSelected &&
    selectedOption !== null &&
    hook.isOptionResumable(selectedOption);

  return (
    <div className="space-y-3">
      <CrossChainSourceChooser
        options={pathOptions}
        selectedKey={selectedKey}
        onSelect={(o) => setSelectedKey(o.key)}
        requiredAtomic={props.requiredAtomic}
        displayDecimals={props.displayDecimals}
        directIsGasless={props.directIsGasless}
      />
      {isDirectSelected && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {t('directSelectedHint')}
        </p>
      )}
      {resumable && !isExecuting && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t('resumeHint')}
        </p>
      )}
      {!isDirectSelected && (
        <button
          type="button"
          onClick={onPay}
          disabled={payButtonDisabled}
          className="w-full rounded-lg bg-sky-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {isExecuting
            ? `${t('inProgress')}${progress ? ` — ${formatProgress(progress, t)}` : ''}`
            : resumable
              ? t('payResume')
              : t('payWithSelected')}
        </button>
      )}
      {error && (
        <p className="text-xs text-red-700">
          {t('errorPrefix')}: {error.message}
        </p>
      )}
    </div>
  );
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
    case 'fee_sign':
      return t('progressFeeSign');
    case 'fee_attest':
      return t('progressFeeAttest');
    case 'fee_source_tx_pending':
      return t('progressFeeSourceTxPending');
    case 'fee_dest_tx_pending':
      return t('progressFeeDestTxPending');
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
