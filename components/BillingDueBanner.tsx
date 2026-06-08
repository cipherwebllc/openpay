'use client';

// OpenPay 利用料 (a1) の **予告バナー**。前月分の利用料が未払いで、かつ **まだ猶予中**
// (= delinquent でない) のときだけ、店主に「お支払い時期です・○日以降は止まります」と非ブロッキングで
// 告知する。突然ゲート (ガスレス停止 + /history ぼかし) が発動して驚く事故を防ぐ「予告 → 猶予 → 締める」
// の予告段。猶予を過ぎ delinquent になるとバナーは消え、ゲート側に引き継がれる (二重提示しない)。
//
// SIWE ログイン済 + a1 点灯時のみ enabled (店主 wallet を識別して fee 状況を引くため)。
// bypass(アルファ) / 支払い済み / 前月請求なし / 延滞後 は出さない。設計: docs/plans/merchant-gasless-fee-a1.md。

import Link from 'next/link';
import { formatUnits } from 'viem';
import { useTranslations, useLocale } from 'next-intl';
import { env } from '@/lib/env';
import { useSiweSession } from '@/hooks/useSiweSession';
import { useBillingInvoice } from '@/hooks/useBillingInvoice';

// wei (18 decimals) → JPYC 表示 (末尾 0 を整理)。
function formatJpyc(wei: string): string {
  const s = formatUnits(BigInt(wei), 18);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function BillingDueBanner() {
  const t = useTranslations('UsageFee');
  const locale = useLocale();
  const { isSignedIn } = useSiweSession();
  const enabled = env.enableUsageFee && isSignedIn;
  const invoice = useBillingInvoice(enabled);

  const data = invoice.data;
  if (!enabled || !data) return null;

  // 猶予中 (前月請求あり・未払い・まだ delinquent でない) のときだけ予告。
  const dueWei = BigInt(data.due.feeWei);
  const show =
    !data.bypass && !data.feeCurrent && !data.delinquent && dueWei > 0n;
  if (!show) return null;

  const deadline = new Date(data.graceEndsAt).toLocaleDateString(
    locale === 'ja' ? 'ja-JP' : 'en-US',
    { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' },
  );

  return (
    <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 print:hidden">
      <p className="text-sm font-semibold text-amber-900">
        {t('dueBannerTitle')}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-amber-800">
        {t('dueBannerBody', { fee: formatJpyc(data.due.feeWei), date: deadline })}
      </p>
      <Link
        href={`/${locale}/billing`}
        className="mt-2 inline-block rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
      >
        {t('dueBannerCta')}
      </Link>
    </div>
  );
}
