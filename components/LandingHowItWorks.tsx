// 「使い方」: 受取側 (merchant) と支払側 (customer) の 3-step フロー。
// Server Component。
//
// customer step 2 は t.rich() で <scan> tag を /scan へのテキストリンクとして
// 描画する (一般ユーザに「/scan」path 表記は分かりにくいため)。

import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

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
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('howItWorksTitle')}
        </h2>
        <p className="mt-2 text-sm text-slate-600">{t('howItWorksSubtitle')}</p>
      </div>

      {/* 実機 (iPhone) で撮った実際の操作デモ。静止画の図より「本当に動く」が
          伝わるため、決済QR作成フロー (受取先 → 金額 → 全画面QR) の録画を提示する。
          autoplay/muted/loop/playsInline で GIF 同等に自動再生 (iOS Safari 含む)、
          自動再生が抑止される環境では poster (最終QR画面) を表示する。 */}
      <div className="mt-8 flex justify-center">
        <div className="overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 p-3 shadow-sm">
          <video
            className="h-auto w-[260px] rounded-2xl sm:w-[300px]"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            poster="/demo/create-qr-mobile-poster.png"
            aria-label={t('howItWorksDemoAlt')}
          >
            <source src="/demo/create-qr-mobile.mp4" type="video/mp4" />
          </video>
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-slate-500">
        {t('howItWorksDemoCaption')}
      </p>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <article className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-emerald-900">
            {t('howItWorksMerchantTitle')}
          </h3>
          <ol className="mt-3 space-y-3">
            {merchant.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
          <h3 className="text-base font-semibold text-blue-900">
            {t('howItWorksCustomerTitle')}
          </h3>
          <ol className="mt-3 space-y-3">
            {customer.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-700">
                <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </article>
      </div>
    </section>
  );
}
