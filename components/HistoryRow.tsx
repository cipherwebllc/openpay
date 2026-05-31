'use client';

// 履歴 1 行分の card 表示。sm 以上で 2 カラム grid、未満で 1 カラム積み重ね。

import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { addressExplorerUrl, txExplorerUrl } from '@/lib/chains';
import {
  formatHistoryTimestamp,
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
  type CircleVerification,
  type HistoryEntry,
} from '@/lib/history';
import { shortAddress } from '@/lib/format';

function fmt(raw: string | null, asset: HistoryEntry['asset']): string {
  if (raw === null) return '—';
  if (!/^\d+$/.test(raw)) return raw;
  return `${formatUnits(BigInt(raw), HISTORY_ASSET_DECIMALS[asset])} ${HISTORY_ASSET_DISPLAY[asset]}`;
}

// status / flow → i18n key (History namespace) と badge class の lookup。
// `as const satisfies Record<...>` で漏れがあれば compile error にする。
const STATUS_BADGE_CLASS = {
  success: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  reverted: 'bg-amber-100 text-amber-800 ring-amber-200',
  error: 'bg-red-100 text-red-800 ring-red-200',
} as const satisfies Record<HistoryEntry['status'], string>;

const STATUS_I18N_KEY = {
  success: 'statusSuccess',
  reverted: 'statusReverted',
  error: 'statusError',
} as const satisfies Record<HistoryEntry['status'], string>;

const FLOW_KIND_I18N_KEY = {
  batch: 'kindBatch',
  direct: 'kindDirect',
  'standard-merchant': 'kindStandardMerchant',
  'standard-fee': 'kindStandardFee',
} as const satisfies Record<HistoryEntry['flow'], string>;

// Circle 徴収額の検証ステータス → badge class + i18n key。
//   verified        : server verifier が on-chain receipt で再計算・一致 (緑)
//   client-reported : client が best-effort 算出 (server 未検証・中立色)
//   unreconciled    : binding 不一致 / event 不在 / 無徴収 等で照合不能 (注意色)
const CIRCLE_VERIF_BADGE_CLASS = {
  verified: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  'client-reported': 'bg-slate-100 text-slate-600 ring-slate-200',
  unreconciled: 'bg-amber-100 text-amber-800 ring-amber-200',
} as const satisfies Record<CircleVerification, string>;

const CIRCLE_VERIF_I18N_KEY = {
  verified: 'circleVerifiedBadge',
  'client-reported': 'circleClientReportedBadge',
  unreconciled: 'circleUnreconciledBadge',
} as const satisfies Record<CircleVerification, string>;

const CIRCLE_VERIF_HELP_KEY = {
  verified: 'circleVerifiedHelp',
  'client-reported': 'circleClientReportedHelp',
  unreconciled: 'circleUnreconciledHelp',
} as const satisfies Record<CircleVerification, string>;

export function HistoryRow({
  entry,
  onRemove,
}: {
  entry: HistoryEntry;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations('History');
  // 履歴に保存した chainId で URL を解決 (NETWORK_ENV mismatch のときは
  // supportedChains に該当しないため undefined になり Explorer リンクは描画されない)。
  const txUrl = entry.txHash
    ? txExplorerUrl(entry.chainId, entry.txHash)
    : undefined;
  const merchantUrl = addressExplorerUrl(entry.chainId, entry.merchant);

  function handleRemove() {
    if (!window.confirm(t('removeRowConfirm'))) return;
    onRemove(entry.id);
  }

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${STATUS_BADGE_CLASS[entry.status]}`}
          >
            {t(STATUS_I18N_KEY[entry.status])}
          </span>
          <span className="text-[11px] text-slate-500">
            {t(FLOW_KIND_I18N_KEY[entry.flow])}
          </span>
        </div>
        <time className="font-mono text-xs text-slate-500">
          {formatHistoryTimestamp(entry.ts)}
        </time>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-2xl font-bold text-slate-900">
          {fmt(entry.merchantAmount, entry.asset)}
        </div>
        <div className="text-[11px] text-slate-500">
          {entry.payMode === 'gasless' ? t('modeGasless') : t('modeStandard')}
          {' · '}
          {entry.gasMode === null
            ? t('gasModeNotApplicable')
            : entry.gasMode === 'customer'
              ? t('gasModeCustomer')
              : t('gasModeMerchant')}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="text-slate-400">{t('columnMerchant')}</dt>
          <dd className="font-mono">
            {merchantUrl ? (
              <a
                href={merchantUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2 hover:text-slate-900"
              >
                {shortAddress(entry.merchant)}
              </a>
            ) : (
              shortAddress(entry.merchant)
            )}
          </dd>
        </div>
        {entry.customer && (
          <div>
            <dt className="text-slate-400">{t('columnCustomer')}</dt>
            <dd className="font-mono">{shortAddress(entry.customer)}</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-400">{t('columnNetwork')}</dt>
          <dd>{entry.chainSlug}</dd>
        </div>
        <div>
          {/* alpha 中は OpenPay 利用手数料 0% のため、gasless で feeAmount>0 のときは
              それは運営が立替えた gas の実費回収 (ネットワーク手数料相当・JPYC sponsorship)
              であり利用手数料ではない。よってその場合は「ネットワーク手数料」と表示する。
              (恒久対応: feeAmount に service fee と gas reimbursement を混在させず分離記録する。
               将来 service fee>0 にする際は必須 — 下記 CSV/stats も同根。) */}
          <dt className="text-slate-400">
            {entry.payMode === 'gasless' &&
            entry.feeAmount != null &&
            entry.feeAmount !== '0' &&
            entry.feeAmount !== ''
              ? t('columnNetworkFee')
              : t('columnFee')}
          </dt>
          <dd>{fmt(entry.feeAmount, entry.asset)}</dd>
        </div>
        {entry.provider === 'circle' &&
          (entry.circlePaymasterNetUsdc || entry.circleVerification) && (
            <div>
              <dt className="text-slate-400">{t('columnCircleGas')}</dt>
              <dd className="flex flex-wrap items-center gap-1.5">
                <span>{fmt(entry.circlePaymasterNetUsdc, 'usdc')}</span>
                {entry.circleVerification && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${CIRCLE_VERIF_BADGE_CLASS[entry.circleVerification]}`}
                    title={t(CIRCLE_VERIF_HELP_KEY[entry.circleVerification])}
                  >
                    {t(CIRCLE_VERIF_I18N_KEY[entry.circleVerification])}
                  </span>
                )}
              </dd>
            </div>
          )}
        {entry.note && (
          <div className="sm:col-span-2">
            <dt className="text-slate-400">{t('columnNote')}</dt>
            <dd className="break-words">{entry.note}</dd>
          </div>
        )}
        {entry.errorMessage && (
          <div className="sm:col-span-2">
            <dt className="text-slate-400">{t('columnStatus')}</dt>
            <dd className="text-red-700">
              {t('errorPrefix')}
              {entry.errorMessage}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-brand underline underline-offset-2 hover:opacity-80"
          >
            {t('viewOnExplorer')}
          </a>
        ) : (
          <span className="text-xs text-slate-400" aria-hidden>
            —
          </span>
        )}
        <button
          type="button"
          onClick={handleRemove}
          className="text-[11px] text-slate-400 underline underline-offset-2 hover:text-red-600"
          aria-label={t('removeRow')}
        >
          {t('removeRow')}
        </button>
      </div>
    </li>
  );
}
