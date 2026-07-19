'use client';

// /create 下部に表示する「最近の取引 (最新 3 件)」ミニコンポーネント。
// 店舗が決済直後に入金確認できる導線を提供。フル履歴は /history へ。
//
// 設計: useHistory().entries は降順 (最新が index 0)。standard mode は merchant
// 送金 tx の直後に OpenPay 利用手数料 tx を追加で append するため、entries は
// [..., standard-fee, standard-merchant, ...] の順で並ぶ (appendHistory は prepend、
// 追加順は merchant → fee なので最新が fee)。本 mini 表示では「店主が受け取った金額」
// だけを見せたいので flow='standard-fee' を filter で除外してから slice(0, 3)。
// /history のフル表示では fee tx も意味があるので除外しない (HistoryView の責務)。

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { History as HistoryIcon, ArrowDown, ArrowRight } from 'lucide-react';
import {
  HISTORY_ASSET_DECIMALS,
  HISTORY_ASSET_DISPLAY,
  formatHistoryTimestamp,
  type HistoryEntry,
} from '@/lib/history';
import { chainNameForId, txExplorerUrl } from '@/lib/chains';
import { TokenLogo } from './AssetLogo';
import { useHistory } from '@/hooks/useHistory';
import type { Locale } from '@/i18n';

const STATUS_DOT_CLASS = {
  success: 'bg-emerald-500',
  reverted: 'bg-amber-500',
  error: 'bg-red-500',
  pending: 'bg-sky-500',
} as const satisfies Record<HistoryEntry['status'], string>;

const STATUS_I18N_KEY = {
  success: 'statusSuccess',
  reverted: 'statusReverted',
  error: 'statusError',
  pending: 'statusPending',
} as const satisfies Record<HistoryEntry['status'], string>;

const RECENT_LIMIT = 3;

function formatAmount(raw: string, asset: HistoryEntry['asset']): string {
  if (!/^\d+$/.test(raw)) return raw;
  return `${formatUnits(BigInt(raw), HISTORY_ASSET_DECIMALS[asset])} ${HISTORY_ASSET_DISPLAY[asset]}`;
}

export function MiniHistoryRecent() {
  const t = useTranslations('Create');
  const tHistory = useTranslations('History');
  const locale = useLocale() as Locale;
  const { entries, hydrated } = useHistory();

  // SSR / hydrate 前は固定高 placeholder で CLS を抑える。
  if (!hydrated) {
    return <div aria-hidden className="mt-6 h-32" />;
  }

  // standard-fee (OpenPay 利用手数料の独立 tx) は merchant への売上ではないので
  // mini 表示からは除外。standard-merchant + batch + direct のみを最新 N 件として
  // 表示する。
  const recent = entries
    .filter((e) => e.flow !== 'standard-fee')
    .slice(0, RECENT_LIMIT);

  return (
    <section
      aria-labelledby="mini-history-heading"
      className="mt-6 rounded-3xl bg-white p-6 shadow-card ring-1 ring-slate-200/70 sm:p-8 print:hidden"
    >
      <h2
        id="mini-history-heading"
        className="flex items-center gap-2 text-base font-semibold text-slate-800"
      >
        <HistoryIcon className="h-5 w-5 text-brand" aria-hidden />
        {t('recentHistoryTitle')}
      </h2>

      {recent.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">{t('recentHistoryEmpty')}</p>
      ) : (
        <>
          <ul className="mt-4 space-y-2">
            {recent.map((entry) => {
              const txUrl = entry.txHash
                ? txExplorerUrl(entry.chainId, entry.txHash)
                : undefined;
              const chainName = chainNameForId(entry.chainId);
              return (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT_CLASS[entry.status]}`}
                      aria-label={tHistory(STATUS_I18N_KEY[entry.status])}
                    />
                    <div className="min-w-0">
                      {/* 受取方向 ↓ + トークンロゴ (HistoryRow #190 と同じ意味論・この
                          strip は受取のみを表示するため常に ↓)。 */}
                      <p className="flex items-center gap-1.5 font-semibold text-slate-900">
                        <ArrowDown
                          className="h-3.5 w-3.5 shrink-0 text-emerald-600"
                          strokeWidth={2.5}
                          aria-hidden
                        />
                        <TokenLogo
                          symbol={entry.asset}
                          size={16}
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="truncate">
                          {formatAmount(entry.merchantAmount, entry.asset)}
                        </span>
                      </p>
                      <p className="truncate text-[11px] text-slate-500">
                        {formatHistoryTimestamp(entry.ts)}
                        {chainName && <> · {chainName}</>}
                      </p>
                    </div>
                  </div>
                  {txUrl && (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-shrink-0 text-[11px] font-medium text-brand hover:underline"
                    >
                      tx ↗
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          <Link
            href={`/${locale}/history`}
            prefetch={false}
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
          >
            {t('recentHistoryViewAll')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </>
      )}
    </section>
  );
}
