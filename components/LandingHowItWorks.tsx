// 「使い方」: 受取側 (merchant) と支払側 (customer) の 3-step フロー。
// Server Component。
//
// customer step 2 は t.rich() で <scan> tag を /scan へのテキストリンクとして
// 描画する (一般ユーザに「/scan」path 表記は分かりにくいため)。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { LandingEntryPoints } from '@/components/LandingEntryPoints';
import { Smartphone, Store } from 'lucide-react';
import { LandingSectionHeader } from '@/components/LandingSectionHeader';
import { STEP_BADGE, STEP_BADGE_CUSTOMER } from '@/components/guide/PosGuidePieces';

export async function LandingHowItWorks() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  const merchant: ReactNode[] = [
    t('howItWorksMerchantStep1'),
    t('howItWorksMerchantStep2'),
    t('howItWorksMerchantStep3'),
  ];
  const customer: ReactNode[] = [
    t('howItWorksCustomerStep1'),
    t.rich('howItWorksCustomerStep2', {
      scan: (chunks) => (
        <Link
          href={`/${locale}/scan`}
          prefetch={false}
          className="font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
        >
          {chunks}
        </Link>
      ),
    }),
    t('howItWorksCustomerStep3'),
  ];

  return (
    <section className="mt-16 sm:mt-28">
      <LandingSectionHeader eyebrow={t('eyebrowStart')} title={t('howItWorksTitle')} lead={t('howItWorksSubtitle')} />

      {/* 操作デモの動画 3 本は旧 UI (ALPHA の帯・旧ヘッダ・CoinGecko 表記) だったので外した (2026-10-12 user 裁定)。
          今の画面で撮り直したら、手順のカードの上に戻す (plans/lp-polish-2026-10.md P2)。旧素材は public/demo/*-mobile.{mp4,gif}
          と *-poster.png に残してある (scripts/gen-intro-video.mjs の素材・撮り直しの作り方は memory の LP デモ動画)。 */}
      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <article className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200/70">
          <h3 className="flex items-center gap-2 text-base font-semibold text-emerald-900">
            <Store aria-hidden className="h-5 w-5 text-emerald-600" />
            {t('howItWorksMerchantTitle')}
          </h3>
          <ol className="mt-3 space-y-3">
            {merchant.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                <span className={STEP_BADGE}>{i + 1}</span>
                <span className="pt-0.5 leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200/70">
          <h3 className="flex items-center gap-2 text-base font-semibold text-blue-900">
            <Smartphone aria-hidden className="h-5 w-5 text-blue-600" />
            {t('howItWorksCustomerTitle')}
          </h3>
          <ol className="mt-3 space-y-3">
            {customer.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                <span className={STEP_BADGE_CUSTOMER}>{i + 1}</span>
                <span className="pt-0.5 leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </article>
      </div>

      {/* ガイドへの入口はここ 1 か所 (手順を読んだ直後の「次の一歩」・ガイドのハブと同じカード)。 */}
      <LandingEntryPoints />

    </section>
  );
}
