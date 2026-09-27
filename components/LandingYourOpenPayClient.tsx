'use client';

// トップの「あなたの OpenPay」帯の client 部分 (plans/lp-polish-2026-09.md P4a)。
//   - YourOpenPayFrame: 帯を出すかの切り替えだけ (中身は server が描く)。
//   - YourOpenPayToday: 今日の売上 (TodayCard と同じ端末内の集計・ネットワークなし)。
// 未接続の訪問者には帯を描かず (display:none)、リクエストも増やさない。

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { ChevronRight } from 'lucide-react';
import { HISTORY_ASSET_DECIMALS, localDateKey, readTodaySummary, type TodayMerchantSummary } from '@/lib/history';
import { RETURNING_WALLET_PREPAINT, useReturningWallet } from '@/hooks/useReturningWallet';

export function YourOpenPayFrame({ children }: { children: ReactNode }) {
  const { hydrating, returning } = useReturningWallet();
  const { status } = useAccount();
  // 再訪の目印があれば、このページを開いている間は枠を出し続ける (再接続の失敗・切断で下の節を押し上げない)。
  // 目印がなくても、つながっていれば出す (このページでつないだとき = user の操作・アプリ内の移動で来たとき = 最初から)。
  const visible = returning === null ? null : returning || status === 'connected';
  return (
    // null は server と hydration のときだけ。属性を描かず、script が付けた値を hydration で消さない。
    // 判定後は yes / no を明示して上書きする (script の値が残らないように)。
    <div data-returning={visible === null ? undefined : visible ? 'yes' : 'no'} suppressHydrationWarning className="hidden data-[returning=yes]:block print:hidden">
      {/* script は server の HTML と hydration のときだけ描く (client だけの描画では React が script を実行しない)。 */}
      {hydrating ? <script dangerouslySetInnerHTML={{ __html: RETURNING_WALLET_PREPAINT }} /> : null}
      {children}
    </div>
  );
}

// raw atomic → 表示用の数値 (非数値は 0)。表示の丸めだけに使い、累積はしない (TodayCard と同じ)。
function atomicToNumber(atomic: string, decimals: number): number {
  if (!/^\d+$/.test(atomic)) return 0;
  const n = Number(formatUnits(BigInt(atomic), decimals));
  return Number.isFinite(n) ? n : 0;
}

export function YourOpenPayToday({ label }: { label: string }) {
  const t = useTranslations('Today');
  const locale = useLocale();
  const { address, status } = useAccount();
  const [today, setToday] = useState<TodayMerchantSummary | null>(null);

  useEffect(() => {
    // 個人の中身は今つながっているときだけ (再訪の目印だけでは出さない)。切断・アドレス変更で消す。
    if (status !== 'connected' || !address) {
      setToday(null);
      return;
    }
    const summary = readTodaySummary();
    const mine = summary && summary.date === localDateKey(Date.now()) ? summary.byMerchant[address.toLowerCase()] ?? null : null;
    setToday(mine && mine.count > 0 ? mine : null);
  }, [status, address]);

  if (!today) return null;
  const yen = Math.round(atomicToNumber(today.jpycAtomic, HISTORY_ASSET_DECIMALS.jpyc));
  const usdc = atomicToNumber(today.usdcAtomic, HISTORY_ASSET_DECIMALS.usdc);

  // 見出しの行 (高さ固定) の右に 1 行で収める。出ても消えても、行の高さと下の段は動かない。
  return (
    <Link
      href={`/${locale}/history`}
      prefetch={false}
      className="inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-brand/5 pl-3 pr-1.5 text-slate-900 ring-1 ring-brand/15 transition hover:ring-brand/40"
    >
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      <span className="text-sm font-bold tabular-nums">¥{yen.toLocaleString('en-US')}</span>
      {usdc > 0 ? <span className="hidden text-xs font-semibold text-slate-600 sm:inline">{t('usdc', { amount: usdc.toFixed(2) })}</span> : null}
      <span className="text-xs text-slate-600">{t('count', { count: today.count })}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-brand" aria-hidden />
    </Link>
  );
}
