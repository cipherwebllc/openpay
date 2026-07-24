'use client';

// 履歴 1 行分の card 表示。sm 以上で 2 カラム grid、未満で 1 カラム積み重ね。

import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { ArrowDown, ChevronDown } from 'lucide-react';
import {
  addressExplorerUrl,
  chainNameForId,
  slugForChain,
  txExplorerUrl,
} from '@/lib/chains';
import { TokenLogo, ChainLogo } from './AssetLogo';
import {
  entryLineItems,
  entryTotals,
  formatHistoryTimestamp,
  hasSeparatedBreakdown,
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
  networkFeeEquivalentOf,
  type CircleVerification,
  type HistoryEntry,
} from '@/lib/history';
import { shortAddress } from '@/lib/format';
import { displaySymbolFor } from '@/lib/tokens';

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
  pending: 'bg-sky-100 text-sky-800 ring-sky-200',
} as const satisfies Record<HistoryEntry['status'], string>;

const STATUS_I18N_KEY = {
  success: 'statusSuccess',
  reverted: 'statusReverted',
  error: 'statusError',
  pending: 'statusPending',
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
  flash = false,
}: {
  entry: HistoryEntry;
  onRemove: (id: string) => void;
  /** push 通知タップ着地の一時ハイライト (~3.5s)。解除は transition でフェード。 */
  flash?: boolean;
}) {
  const t = useTranslations('History');
  // anchor 行は PaymentForm の fxAnchorLine/fxRateLine を再利用 (文言を一元化)。
  const tp = useTranslations('PaymentForm');
  // 履歴に保存した chainId で URL を解決 (NETWORK_ENV mismatch のときは
  // supportedChains に該当しないため undefined になり Explorer リンクは描画されない)。
  const txUrl = entry.txHash
    ? txExplorerUrl(entry.chainId, entry.txHash)
    : undefined;
  const merchantUrl = addressExplorerUrl(entry.chainId, entry.merchant);

  // v3 fee/gas 分離表示。
  // - OpenPay 利用手数料 (サービス料): native v3 で > 0 のときだけ行を出す (alpha / 将来とも
  //   0 = 非表示。決済額非連動・収益化は周辺機能で決済フロー非経由)。
  // - ネットワーク手数料相当額: 全経路横断の統一項目 (networkFeeEquivalentOf で coalesce)。
  //   circle は検証ステータス badge を併記。
  // - legacy(migrated v2): 分離記録が無く feeAmount に gas が混在しうるため、gasless かつ
  //   feeAmount > 0 を旧 band-aid (PR #23) でネットワーク手数料相当額として表示する。
  const separated = hasSeparatedBreakdown(entry);
  const netFeeRaw = separated
    ? networkFeeEquivalentOf(entry)
    : entry.payMode === 'gasless'
      ? entry.feeAmount
      : null;
  const isNonZero = (v: string | null): boolean =>
    v != null && v !== '0' && v !== '';
  const isCircle = entry.provider === 'circle';
  // circle は net 不明 (unreconciled) でも検証ステータスを可視化するため行を出す。
  const showNetFee =
    isNonZero(netFeeRaw) || (isCircle && entry.circleVerification != null);
  const showServiceFee = separated && isNonZero(entry.feeAmount);
  // 売上総額は着金額 (merchantAmount) と異なるとき (gas=merchant / split 等) のみ明示。
  // 一致時は上部の大きな金額が兼ねる。
  const showGrossSale =
    entry.saleAmount != null && entry.saleAmount !== entry.merchantAmount;

  // v5 売上明細表示。entryLineItems で単品/legacy も仮想 1 行に正規化、entryTotals で
  // 合計税額 (token 単位の内税・記帳補助の参考値) を派生する。税額は token 単位なので
  // USDC でも JPY へ強制変換しない (JPY 換算は GMV サマリ側の責務)。
  const items = entryLineItems(entry);
  const totals = entryTotals(entry);
  const tokenSymbol = HISTORY_ASSET_DISPLAY[entry.asset];
  const repName = items.length > 0 ? items[0].name : '';
  const showTax =
    items.some((li) => li.taxRate != null && li.taxRate > 0) ||
    (entry.taxRate != null && entry.taxRate > 0);

  function handleRemove() {
    if (!window.confirm(t('removeRowConfirm'))) return;
    onRemove(entry.id);
  }

  const gasModeLabel =
    entry.gasMode === null
      ? t('gasModeNotApplicable')
      : entry.gasMode === 'customer'
        ? t('gasModeCustomer')
        : t('gasModeMerchant');

  return (
    <li className="list-none">
      <details
        className={`group overflow-hidden rounded-2xl bg-white shadow-card transition-all duration-700 open:shadow-card-hover ${
          flash
            ? 'ring-2 ring-emerald-300 bg-emerald-50/50'
            : 'ring-1 ring-slate-200/70'
        }`}
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 p-4 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            {/* メタ行: 受取バッジ + 状態 + 種別 / 右に日時 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                {t('directionInBadge')}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${STATUS_BADGE_CLASS[entry.status]}`}
                title={
                  entry.status === 'reverted'
                    ? t('statusRevertedTooltip')
                    : undefined
                }
              >
                {t(STATUS_I18N_KEY[entry.status])}
              </span>
              <span className="text-[11px] text-slate-500">
                {t(FLOW_KIND_I18N_KEY[entry.flow])}
              </span>
              <time className="ml-auto shrink-0 font-mono text-[11px] text-slate-500">
                {formatHistoryTimestamp(entry.ts)}
              </time>
            </div>

            {/* 金額行: 方向矢印 + token + 大きな金額 + chain。矢印は装飾 (方向は上の
                受取バッジが伝達済み)・受取=↓ を badge と同じ emerald で。 */}
            <div className="mt-2 flex items-center gap-2">
              <ArrowDown
                className="h-5 w-5 shrink-0 text-emerald-600"
                strokeWidth={2.5}
                aria-hidden
              />
              <TokenLogo
                symbol={entry.asset}
                size={22}
                className="h-[22px] w-[22px] shrink-0"
              />
              <span className="text-2xl font-bold text-slate-900">
                {fmt(entry.merchantAmount, entry.asset)}
              </span>
              {(() => {
                const slug = slugForChain(entry.chainId);
                return slug ? (
                  <ChainLogo
                    slug={slug}
                    size={16}
                    alt={chainNameForId(entry.chainId) ?? slug}
                    className="h-4 w-4 shrink-0 opacity-80"
                  />
                ) : null;
              })()}
            </div>

            {/* 商品名 (あれば) */}
            {repName && (
              <p className="mt-1 break-words text-sm font-medium text-slate-600">
                {repName}
                {items.length === 1 && items[0].quantity > 1 && (
                  <span className="text-slate-500"> ×{items[0].quantity}</span>
                )}
                {items.length > 1 && (
                  <span className="text-slate-500">
                    {' '}
                    {t('itemCountMore', { count: items.length - 1 })}
                  </span>
                )}
              </p>
            )}
          </div>
          <ChevronDown
            className="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>

        <div className="border-t border-slate-100 px-4 pb-4 pt-3">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">{t('columnMode')}</dt>
          <dd>
            {entry.payMode === 'gasless'
              ? t('modeGasless')
              : t('modeStandard')}
            {' · '}
            {gasModeLabel}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">{t('columnMerchant')}</dt>
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
            <dt className="text-slate-500">{t('columnCustomer')}</dt>
            <dd className="font-mono">{shortAddress(entry.customer)}</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-500">{t('columnNetwork')}</dt>
          <dd>{entry.chainSlug}</dd>
        </div>
        {showGrossSale && (
          <div>
            <dt className="text-slate-500">{t('columnSaleAmount')}</dt>
            <dd>{fmt(entry.saleAmount, entry.asset)}</dd>
          </div>
        )}
        {showServiceFee && (
          <div>
            <dt className="text-slate-500">{t('columnFee')}</dt>
            <dd>{fmt(entry.feeAmount, entry.asset)}</dd>
          </div>
        )}
        {showNetFee && (
          <div>
            <dt className="text-slate-500">{t('columnNetworkFee')}</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <span>{fmt(netFeeRaw, entry.asset)}</span>
              {isCircle && entry.circleVerification && (
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
        {entry.anchorAmount != null && entry.anchorSymbol && (
          <div className="sm:col-span-2">
            <dt className="text-slate-500">{t('columnAnchor')}</dt>
            <dd className="break-words text-slate-700">
              {tp('fxAnchorLine', {
                refAmt: entry.anchorAmount,
                anchorSymbol: displaySymbolFor(entry.anchorSymbol),
                amount: /^\d+$/.test(entry.merchantAmount)
                  ? formatUnits(
                      BigInt(entry.merchantAmount),
                      HISTORY_ASSET_DECIMALS[entry.asset],
                    )
                  : entry.merchantAmount,
                symbol: HISTORY_ASSET_DISPLAY[entry.asset],
              })}
              {entry.fxRateUsdcJpy &&
                ` ・ ${tp('fxRateLine', { rate: entry.fxRateUsdcJpy })}`}
            </dd>
          </div>
        )}
        {items.length > 0 && (
          <div className="sm:col-span-2">
            <dt className="text-slate-500">{t('lineItemsLabel')}</dt>
            <dd>
              <ul className="mt-0.5 space-y-0.5">
                {items.map((li) => (
                  <li
                    key={li.id}
                    className="flex flex-wrap items-baseline justify-between gap-2"
                  >
                    <span className="break-words">
                      {li.name}{' '}
                      <span className="text-slate-500">×{li.quantity}</span>
                      {li.taxRate != null && li.taxRate > 0 && (
                        <span className="ml-1 text-slate-500">{li.taxRate}%</span>
                      )}
                    </span>
                    <span className="font-mono text-slate-700">
                      @{li.unitPrice} = {li.amount}
                    </span>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {showTax && (
          <div>
            <dt className="text-slate-500">{t('columnTaxAmount')}</dt>
            <dd>
              {totals.totalTax} {tokenSymbol}
            </dd>
          </div>
        )}
        {entry.receiptNo && (
          <div>
            <dt className="text-slate-500">{t('columnReceiptNo')}</dt>
            <dd className="font-mono break-all">{entry.receiptNo}</dd>
          </div>
        )}
        {entry.memo && (
          <div className="sm:col-span-2">
            <dt className="text-slate-500">{t('columnMemo')}</dt>
            <dd className="break-words">{entry.memo}</dd>
          </div>
        )}
        {entry.note && (
          <div className="sm:col-span-2">
            <dt className="text-slate-500">{t('columnNote')}</dt>
            <dd className="break-words">{entry.note}</dd>
          </div>
        )}
        {entry.errorMessage && (
          <div className="sm:col-span-2">
            <dt className="text-slate-500">{t('columnStatus')}</dt>
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
          className="text-[11px] text-slate-500 underline underline-offset-2 hover:text-red-600"
          aria-label={t('removeRow')}
        >
          {t('removeRow')}
        </button>
      </div>
        </div>
      </details>
    </li>
  );
}
