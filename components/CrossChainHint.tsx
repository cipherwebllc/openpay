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

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { formatUnits, type Address } from 'viem';
import { useTranslations } from 'next-intl';
import { useCrossChainPayment } from '@/hooks/useCrossChainPayment';
import type { ExecuteResult } from '@/hooks/useCrossChainPayment';
import type { CrossChainProgress } from '@/lib/crossChain/execute';
import type { PathOption } from '@/lib/crossChain/pathEnumerator';
import { CROSS_CHAIN_DISABLED } from '@/lib/crossChain/config';
import { ResumeStoreWriteError } from '@/lib/crossChain/resumeStore';
import { blockExplorerUrl } from '@/lib/chains';
import { CrossChainSourceChooser } from './CrossChainSourceChooser';
import { shortAddress } from '@/lib/format';
import { logger } from '@/lib/logger';

// 中断再開でしか描画されない説明パネルなので、/pay・/tip の First Load JS には載せない
// (予算は既に上限張り付き — 掟: 増えたら予算を上げる前にまず code-split)。
const CrossChainBurnUnresolvedPanel = dynamic(
  () =>
    import('./CrossChainBurnUnresolvedPanel').then(
      (m) => m.CrossChainBurnUnresolvedPanel,
    ),
  { ssr: false },
);

export interface CrossChainHintProps {
  /** PaymentForm の token (token !== 'usdc' なら hint を出さない) */
  token: 'usdc' | 'jpyc';
  /** crossChain が許可されているか (URL の crossChain flag) */
  enabled: boolean;
  /** merchant 受取 chain id */
  targetChainId: number;
  /** merchant 受取 address */
  recipient: Address;
  /** 請求額 (invoice amount, atomic)。顧客は source USDC でこの額を支出。
   *  ネットワークガスは native (ETH/POL) 別途負担で USDC 額には含めない。 */
  requiredAtomic: bigint;
  /** OpenPay 利用料の送り先 (operator)。fee=0 (Phase 1 alpha) では使われない。 */
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
  /** 親の通常決済が pending / unknown / success の間、cross-chain execute だけを止める。 */
  executionDisabled?: boolean;
  /** 実行中または不可逆境界到達後の親 Pay 排他状態を通知する。 */
  onExecutingChange?: (executing: boolean) => void;
  /** cross-chain 完了結果を親の成功 UI へ伝える。 */
  onSuccess?: (result: ExecuteResult) => void;
  /** execute 開始時点の請求額を親に snapshot させる。 */
  onAttemptStart?: (amount: bigint) => void;
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
  const {
    decision,
    pathOptions,
    progress,
    isExecuting,
    isCommitted,
    result,
    error,
  } = hook;
  const attemptedAtomicRef = useRef<bigint | null>(null);
  const successNotifiedHashRef = useRef<string | null>(null);
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
        valueAtomic: (
          attemptedAtomicRef.current ?? props.requiredAtomic
        ).toString(),
      });
      if (successNotifiedHashRef.current !== result.mintTxHash) {
        successNotifiedHashRef.current = result.mintTxHash;
        props.onSuccess?.(result);
      }
    }
  }, [result, props.recipient, props.requiredAtomic, props.onSuccess]);

  useEffect(() => {
    // 成功は onSuccess 側の settled lock に引き継ぐ。失敗時は不可逆境界前だけ false に
    // 戻し、burn / attestation 後は親の通常 Pay を同一 mount 中ずっと封鎖する。
    props.onExecutingChange?.(result ? false : isExecuting || isCommitted);
  }, [isCommitted, isExecuting, result, props.onExecutingChange]);

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
        valueAtomic={attemptedAtomicRef.current ?? props.requiredAtomic}
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
    if (!selectedOption || props.executionDisabled) return;
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
    attemptedAtomicRef.current = props.requiredAtomic;
    props.onAttemptStart?.(props.requiredAtomic);
    try {
      // 会計ログ (KV) は useCrossChainPayment の onMerchantMint が merchant mint 確定時
      // (fee mint より前) に発火する。fee mint 失敗でも merchant 着金を取りこぼさず、売上総額
      // (saleAmount) / bridgeFeeMax / burnTxHash など v3 フィールドも含めて記録する。ここでは
      // 実行のみ (success panel は hook.result state が駆動)。
      await hook.executeOption(selectedOption);
    } catch {
      // 実行エラーは hook.error に反映される (ここでは何もしない)。
    }
  }

  const isDirectSelected = selectedOption?.kind === 'direct';
  // 中断再開: 選択中 option に保存済みの途中 state があれば、再 Pay で続きから
  // 再開できる (送金済みは再送しない)。UI で明示して二重支払いの不安を消す。
  const resumable =
    !isDirectSelected &&
    selectedOption !== null &&
    hook.isOptionResumable(selectedOption);
  const burnUnresolved = hook.burnUnresolved;
  const payButtonDisabled =
    isExecuting ||
    !!props.executionDisabled ||
    // 前回 burn が mempool に居る可能性がある間は、再 Pay 自体を押させない (押しても
    // 同じ wait に落ちるだけで、買い手には「二重に払うのでは」という不安だけが残る)。
    burnUnresolved?.kind === 'wait' ||
    // 同一 mount で committed を観測したのに resume 保存が無い場合、再 execute は
    // 二重 burn/debit になり得る。D4b は行わず、この mount の子ボタンだけ fail-closed。
    (isCommitted && !resumable) ||
    !selectedOption ||
    isDirectSelected;

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
      {resumable && !isExecuting && !burnUnresolved && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t('resumeHint')}
        </p>
      )}
      {burnUnresolved && (
        <CrossChainBurnUnresolvedPanel
          kind={burnUnresolved.kind}
          sourceChainId={burnUnresolved.sourceChainId}
          depositor={burnUnresolved.depositor}
          burnTxHash={burnUnresolved.burnTxHash}
          reburnable={burnUnresolved.reburnable}
          armed={hook.isManualReburnArmed}
          onArm={hook.armManualReburn}
        />
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
      {error && !burnUnresolved && (
        <p className="text-xs text-red-700">
          {t('errorPrefix')}:{' '}
          {error instanceof ResumeStoreWriteError
            ? // marker を書けない = 二重 burn を防げないので送金しなかった、という
              // 「安全側に倒した」旨を専用文言で伝える (生の例外文は買い手に無意味)。
              t('errorStorageBlocked')
            : error.message}
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
    case 'burn_probe':
      return t('progressBurnProbe');
    case 'burn_unconfirmed':
      return t('progressBurnUnconfirmed');
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
