'use client';

// 「Arc の売上を受け取る」: 受取アドレスのウォレットをつなぐと、Arc の Gateway 残高を全額 Arc へ引き出せる。
// 状態と手順は hooks/useArcPayout.ts、引き出しの部品は lib/crossChain/arcPayout.ts。

import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { ConnectButton } from '@/components/ConnectButton';
import { txExplorerUrl } from '@/lib/chains';
import { planArcPayout } from '@/lib/crossChain/arcPayout';
import { shortAddress } from '@/lib/format';
import { useArcPayout, type ArcPayoutFailure, type ArcPayoutStatus } from '@/hooks/useArcPayout';

const BTN =
  'rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50';
const LINK_BTN = 'text-sm font-semibold text-brand-dark underline underline-offset-2';

/** USDC (6 桁) の表示。末尾の 0 は落とす (0.030500 → 0.0305)。 */
function usdc(atomic: bigint): string {
  return formatUnits(atomic, 6);
}

/**
 * ウォレットの Arc の USDC (ネイティブ・18 桁) の表示。6 桁で切り捨てる (18 桁の端数をそのまま出すと読めない)。
 * 0 より大きいが 6 桁で 0 になる額は「< 0.000001」(0 と表示すると「入っていない」と誤解させる)。
 */
function arcGas(atomic: bigint): string {
  const micro = atomic / 10n ** 12n;
  if (atomic > 0n && micro === 0n) return '< 0.000001';
  return formatUnits(micro, 6);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="font-mono text-sm text-slate-900">{value}</dd>
    </div>
  );
}

function failureMessage(t: ReturnType<typeof useTranslations<'ArcPayout'>>, failure: ArcPayoutFailure, canContinue: boolean): string {
  switch (failure.code) {
    case 'account_changed':
    case 'mint_not_completed':
      return t('errorMintNotSent');
    case 'confirm_unknown':
      return t('errorConfirmUnknown');
    case 'rejected':
      return canContinue ? t('errorMintNotSent') : t('errorRejected');
    case 'circle_rejected':
      return t('errorCircleRejected', { status: failure.status });
    case 'circle_unknown':
      return t('errorCircleUnknown');
    case 'below_fee':
      return t('errorBelowFeeNow');
    case 'balance_unavailable':
      return t('errorLoad');
    case 'attestation_expired':
      return t('errorExpired');
    case 'failed':
      return canContinue ? t('errorMintNotSent') : t('errorFailed');
  }
}

function Summary({ status, t }: { status: ArcPayoutStatus; t: ReturnType<typeof useTranslations<'ArcPayout'>> }) {
  if (status.balance.status !== 'ok') return null;
  const { available, pending } = status.balance;
  const plan = typeof status.fee === 'bigint' ? planArcPayout(available, status.fee) : null;
  return (
    <dl className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white px-4 py-2">
      <Row label={t('availableLabel')} value={`${usdc(available)} USDC`} />
      <Row label={t('pendingLabel')} value={pending === null ? t('pendingUnknown') : `${usdc(pending)} USDC`} />
      {typeof status.fee === 'bigint' && <Row label={t('feeLabel')} value={`${usdc(status.fee)} USDC`} />}
      {plan?.ok && <Row label={t('receiveLabel')} value={`${usdc(plan.value)} USDC`} />}
      <Row label={t('gasLabel')} value={`${arcGas(status.gas)} USDC`} />
    </dl>
  );
}

export function ArcPayoutPanel() {
  const t = useTranslations('ArcPayout');
  const { address, status, flow, otherPending, withdraw, continueMint, reload, walletReady, arcChainId } = useArcPayout();

  if (!address) {
    return (
      <section className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm text-slate-700">{t('connectPrompt')}</p>
        <div className="mt-3">
          <ConnectButton />
        </div>
      </section>
    );
  }

  const data = status.data;
  const working = flow.phase !== 'idle' && flow.phase !== 'done' && flow.phase !== 'failed';
  // 押せない理由 (上から順に 1 つだけ出す)。
  let blocker: string | null = null;
  if (status.isError || data?.balance.status === 'error') blocker = t('errorLoad');
  else if (data?.contract) blocker = t('contractWallet');
  else if (data && data.balance.status === 'ok' && data.balance.available === 0n) blocker = t('nothingToWithdraw');
  else if (data?.fee === 'error') blocker = t('errorFee');
  else if (data && typeof data.fee === 'bigint' && data.balance.status === 'ok' && !planArcPayout(data.balance.available, data.fee).ok) {
    blocker = t('errorBelowFee', { fee: usdc(data.fee) });
  } else if (data?.gas === 0n) blocker = t('noGas');

  // 進み具合はアドレスごと (hooks/useArcPayout.ts)。続きを送れるのは、表示中のアドレス自身の引き出しだけ。
  const pending = flow.phase === 'failed' ? flow.pending : undefined;
  // Circle の応答が分からなかった直後は、10 分 (失効して残高に戻るまで) 引き出し直させない。
  const coolingDown = flow.phase === 'failed' && flow.retryAfter !== undefined && Date.now() < flow.retryAfter;
  const explorer = flow.phase === 'done' && flow.txHash ? txExplorerUrl(arcChainId, flow.txHash) : undefined;

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-600">
        {t('addressLabel')} <span className="font-mono text-slate-900">{shortAddress(address)}</span>
      </p>

      {status.isPending && <p className="mt-4 text-sm text-slate-500">{t('loading')}</p>}
      {data && <Summary status={data} t={t} />}

      {blocker && (
        <p role="status" className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          {blocker}
        </p>
      )}

      {working && (
        <p role="status" className="mt-4 text-sm font-semibold text-slate-800">{t(`step_${flow.phase}`)}</p>
      )}

      {flow.phase === 'done' && (
        <p role="status" className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          {t('done', { amount: usdc(flow.value) })}{' '}
          {explorer && (
            <a href={explorer} target="_blank" rel="noopener noreferrer" className={LINK_BTN}>
              {t('viewTx')}
            </a>
          )}
        </p>
      )}

      {flow.phase === 'failed' && (
        <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900 ring-1 ring-rose-200">
          {failureMessage(t, flow.failure, !!pending)}
        </p>
      )}

      {otherPending && (
        <p role="status" className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          {t('switchBack', { address: shortAddress(otherPending) })}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {pending ? (
          <button type="button" className={BTN} disabled={working} onClick={() => void continueMint()}>
            {pending.txHash ? t('confirmAgain') : t('retryMint')}
          </button>
        ) : (
          <button
            type="button"
            className={BTN}
            disabled={working || coolingDown || !!blocker || !data || !walletReady}
            onClick={() => void withdraw()}
          >
            {t('withdraw')}
          </button>
        )}
        <button type="button" className={LINK_BTN} disabled={working} onClick={() => void reload()}>
          {t('reload')}
        </button>
      </div>
    </section>
  );
}
