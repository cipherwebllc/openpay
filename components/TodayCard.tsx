'use client';

// 「今日のお店」ダッシュボード — LP (Server Component) の Hero 直下に差し込む小さな
// client カード。接続済みの店主が LP を開いた瞬間に「今日: 売上・件数・最終着金」を
// 見せ、毎朝開く理由をつくる。未接続者・当日データなしには一切表示しない (null)。
//
// 設計:
//   - LP 初期 path で履歴 1000 件を parse しない。appendHistory 時に前方合算した派生
//     summary key (openpay:todaySummary:v1) だけを mount 後に 1 回読む。
//   - SSR / hydrate 前は null (localStorage 不在)。mount 後に読み、接続 wallet と
//     summary.byMerchant のキー (= entry.merchant 小文字) が一致した時のみ描画。
//   - 金額集計は raw atomic を lib 側で BigInt 加算済。ここでは表示整形のみ (Number 化は
//     表示用の丸めに限定・累積には使わない)。

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { CalendarDays, ArrowRight } from 'lucide-react';
import { useAccount } from 'wagmi';
import {
  HISTORY_ASSET_DECIMALS,
  localDateKey,
  readTodaySummary,
  type TodayMerchantSummary,
} from '@/lib/history';
import { pad } from '@/lib/pad';
import type { Locale } from '@/i18n';

// raw atomic → 表示用の数値 (非数値は 0)。表示丸めのみに使い、累積計算はしない。
function atomicToNumber(atomic: string, decimals: number): number {
  if (!/^\d+$/.test(atomic)) return 0;
  const n = Number(formatUnits(BigInt(atomic), decimals));
  return Number.isFinite(n) ? n : 0;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TodayCard() {
  const t = useTranslations('Today');
  const locale = useLocale() as Locale;
  const { address, isConnected } = useAccount();
  const [today, setToday] = useState<TodayMerchantSummary | null>(null);

  useEffect(() => {
    // 未接続 / hydrate 直後は表示しない。接続 wallet 確定後にだけ読む。
    if (!isConnected || !address) {
      setToday(null);
      return;
    }
    const summary = readTodaySummary();
    if (!summary || summary.date !== localDateKey(Date.now())) {
      setToday(null);
      return;
    }
    const mine = summary.byMerchant[address.toLowerCase()] ?? null;
    setToday(mine && mine.count > 0 ? mine : null);
  }, [isConnected, address]);

  if (!today) return null;

  const yen = Math.round(atomicToNumber(today.jpycAtomic, HISTORY_ASSET_DECIMALS.jpyc));
  const usdc = atomicToNumber(today.usdcAtomic, HISTORY_ASSET_DECIMALS.usdc);
  const hasUsdc = usdc > 0;

  return (
    <Link
      href={`/${locale}/history`}
      prefetch={false}
      className="group mt-6 flex items-center justify-between gap-4 rounded-2xl bg-gradient-to-br from-blue-50/80 via-white to-white px-4 py-4 shadow-card ring-1 ring-brand/15 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover hover:ring-brand/30 print:hidden sm:px-5"
    >
      <div className="min-w-0">
        <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500">
          <CalendarDays className="h-3.5 w-3.5 text-brand" aria-hidden />
          {t('title')}
          <span className="text-slate-400">·</span>
          <span className="text-slate-500">{t('count', { count: today.count })}</span>
        </p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[1.75rem] font-bold leading-none tracking-tight text-slate-900 sm:text-3xl">
            ¥{yen.toLocaleString('en-US')}
          </span>
          {hasUsdc && (
            <span className="text-sm font-semibold text-slate-500">
              {t('usdc', { amount: usdc.toFixed(2) })}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {t('lastReceived', { time: formatClock(today.lastTs) })}
        </p>
      </div>
      <span
        aria-hidden
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand transition-all duration-200 group-hover:translate-x-0.5 group-hover:bg-brand group-hover:text-white"
      >
        <ArrowRight className="h-4 w-4" />
      </span>
    </Link>
  );
}
