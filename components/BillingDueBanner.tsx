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

  // 前月分が未払い (請求あり・未清算・非bypass)。2 状態で店主に告知する:
  //   猶予中 (delinquent=false): 予告「お支払い時期です・◯日以降停止」(黄)
  //   延滞中 (delinquent=true) : 停止「ガスレス停止中・客は払えない・払えば再開」(赤) ← /create でも必ず出す
  const dueWei = BigInt(data.due.feeWei);
  const owe = !data.bypass && !data.feeCurrent && dueWei > 0n;
  if (!owe) return null;

  const fee = formatJpyc(data.due.feeWei);

  // 延滞中: ガスレスが実際に止まっている → 強い赤の停止警告 (受取側に必ず気づかせる)。
  if (data.delinquent) {
    return (
      <div className="mb-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 print:hidden">
        <p className="text-sm font-semibold text-red-900">{t('pausedTitle')}</p>
        <p className="mt-1 text-xs leading-relaxed text-red-800">
          {t('pausedBody', { fee })}
        </p>
        <Link
          href={`/${locale}/billing`}
          className="mt-2 inline-block rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
        >
          {t('dueBannerCta')}
        </Link>
      </div>
    );
  }

  // 猶予中: まだ止まっていない → 黄の予告 (○○以降停止)。
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
        {t('dueBannerBody', { fee, date: deadline })}
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
