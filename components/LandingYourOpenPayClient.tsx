'use client';

// トップの「あなたの OpenPay」帯の client 部分 (plans/lp-polish-2026-09.md P4a)。
//   - YourOpenPayFrame: 帯を出すかの切り替えだけ (中身は server が描く)。
//   - YourOpenPayToday: 今日の売上 (TodayCard と同じ端末内の集計・ネットワークなし)。
// 未接続の訪問者には帯を描かず (display:none)、リクエストも増やさない。

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAccount } from 'wagmi';
import { useMutationState } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { HISTORY_ASSET_DECIMALS, localDateKey, readTodaySummary, todayAtomicToNumber, type TodayMerchantSummary } from '@/lib/history';
import { RETURNING_WALLET_PREPAINT, useReturningWallet } from '@/hooks/useReturningWallet';

export function YourOpenPayFrame({ children }: { children: ReactNode }) {
  const { status } = useAccount();
  const { hydrating, returning } = useReturningWallet(status === 'connected');
  const connectedHere = useConnectedOnThisPage(status === 'connected');
  // 枠を出すのは、開いたときに決まった分 (再訪の目印・アプリ内の移動で来たときの接続) と、このページで user がつないだときだけ。
  // 自動の再接続では後から出さない (ヒーローより前に差し込むと、操作なしで下の節を押し下げる)。
  // 開いたときに出した枠は、再接続の失敗・切断でも消さない (同じく押し上げない)。
  const visible = returning === null ? null : returning || connectedHere;
  return (
    // null は server と hydration のときだけ。属性を描かず、script が付けた値を hydration で消さない。
    // 判定後は yes / no を明示して上書きする (script の値が残らないように)。
    // 印刷では出さない: data 属性の block は print:hidden より詳細度が高いので ! で上書きする。
    <div data-returning={visible === null ? undefined : visible ? 'yes' : 'no'} suppressHydrationWarning className="hidden data-[returning=yes]:block print:!hidden">
      {/* script は server の HTML と hydration のときだけ描く (client だけの描画では React が script を実行しない)。 */}
      {hydrating ? <script dangerouslySetInnerHTML={{ __html: RETURNING_WALLET_PREPAINT }} /> : null}
      {children}
    </div>
  );
}

// このページで user がつないだか = ヘッダの接続 (wagmi の connect 操作・mutationKey ['connect']) が、この帯を出したあとに成功した。
// 自動の再接続は connect 操作を通らないので数えない。status や useAccountEffect の isReconnected では見分けられない
// (wagmi は起動時に保存の current を null へ書き戻すので、再接続も 'connecting' から始まり isReconnected=false になる・2026-09-28 確認)。
function useConnectedOnThisPage(connectedNow: boolean): boolean {
  const [mountedAt] = useState(() => Date.now());
  const submittedAt = useMutationState({
    filters: { mutationKey: ['connect'], status: 'success' },
    select: (mutation) => mutation.state.submittedAt,
  });
  return connectedNow && submittedAt.some((at) => at >= mountedAt);
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
  const yen = Math.round(todayAtomicToNumber(today.jpycAtomic, HISTORY_ASSET_DECIMALS.jpyc));
  const usdc = todayAtomicToNumber(today.usdcAtomic, HISTORY_ASSET_DECIMALS.usdc);

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
