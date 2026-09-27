// Hero + 2 大 CTA。Server Component。
// 中央に価値訴求 (eyebrow pill + 大見出し + 本文)、背後に淡いブランドグローで奥行きを与える。
// 2 CTA はアイコンバッジ + ホバー浮上 + 押下フィードバック + 矢印スライドでネイティブ感を出す。

import Image from 'next/image';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ScanLine, QrCode } from 'lucide-react';

export async function LandingHero() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <>
      <section className="relative">
        {/* 装飾: 上部中央からの淡いブランドグロー (奥行き + 温度感)。 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-16 -z-10 mx-auto h-72 max-w-3xl bg-[radial-gradient(60%_60%_at_50%_0%,rgba(59,130,246,0.16),transparent_72%)]"
        />
        <div className="mx-auto max-w-3xl pt-4 text-center sm:pt-10">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-blue-200/70 bg-blue-50/90 px-3 py-1 text-xs font-semibold tracking-wide text-brand">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
            {t('tagline')}
          </p>
          <h2 className="mt-5 text-[2.25rem] font-bold leading-[1.05] tracking-[-0.02em] text-slate-900 sm:text-6xl">
            {t('heroLeadline')}
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-balance text-[15px] leading-relaxed text-slate-500 sm:text-base">
            {t.rich('heroBody', {
              b: (chunks) => <strong className="font-bold text-slate-900">{chunks}</strong>,
            })}
          </p>
        </div>

        <div className="mx-auto mt-8 max-w-3xl overflow-hidden rounded-[1.75rem] bg-white shadow-lift ring-1 ring-slate-200/60 sm:mt-11">
          <Image
            src="/landing/hero-overview.avif"
            alt={t('heroVisualAlt')}
            width={1400}
            height={787}
            priority
            sizes="(min-width: 1024px) 1024px, calc(100vw - 2rem)"
            className="h-auto w-full object-cover"
          />
        </div>
      </section>

      {/* スマホも 2 列 (縦に 2 枚積むと 1 画面の半分を使う・plans/lp-polish-2026-09.md P1)。説明文は見出しと
          同じことを言うので sm 以上だけに出す。リンク名は見出し + ボタンの可視テキスト。 */}
      <section className="mt-7 grid grid-cols-2 gap-3 sm:mt-10 sm:gap-4">
        <Link
          href={`/${locale}/scan`}
          prefetch={false}
          className="group flex min-w-0 flex-col gap-3 rounded-3xl border border-blue-200/70 bg-gradient-to-br from-blue-50 to-blue-100/30 p-4 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-card-hover active:translate-y-0 active:scale-[0.99] sm:gap-4 sm:p-7"
        >
          <div className="flex flex-col items-start gap-2 text-blue-900 sm:flex-row sm:items-center sm:gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-600/10 text-blue-700 sm:h-11 sm:w-11">
              <ScanLine className="h-[22px] w-[22px]" aria-hidden />
            </span>
            <h3 className="text-base font-semibold leading-snug sm:text-xl">{t('ctaScanTitle')}</h3>
          </div>
          <p className="hidden text-sm leading-relaxed text-blue-800/90 sm:block">{t('ctaScanBody')}</p>
          <span className="mt-auto inline-flex w-full items-center justify-center gap-1 rounded-xl bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors group-hover:bg-blue-700 sm:w-fit sm:gap-1.5 sm:px-4 sm:text-sm">
            {t('ctaScanButton')}
            <span
              aria-hidden
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            >
              →
            </span>
          </span>
        </Link>

        <Link
          href={`/${locale}/create`}
          prefetch={false}
          className="group flex min-w-0 flex-col gap-3 rounded-3xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-emerald-100/30 p-4 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-card-hover active:translate-y-0 active:scale-[0.99] sm:gap-4 sm:p-7"
        >
          <div className="flex flex-col items-start gap-2 text-emerald-900 sm:flex-row sm:items-center sm:gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-emerald-600/10 text-emerald-700 sm:h-11 sm:w-11">
              <QrCode className="h-[22px] w-[22px]" aria-hidden />
            </span>
            <h3 className="text-base font-semibold leading-snug sm:text-xl">
              {t('ctaCreateTitle')}
            </h3>
          </div>
          <p className="hidden text-sm leading-relaxed text-emerald-800/90 sm:block">
            {t('ctaCreateBody')}
          </p>
          <span className="mt-auto inline-flex w-full items-center justify-center gap-1 rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors group-hover:bg-emerald-700 sm:w-fit sm:gap-1.5 sm:px-4 sm:text-sm">
            {t('ctaCreateButton')}
            <span
              aria-hidden
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            >
              →
            </span>
          </span>
        </Link>
      </section>
    </>
  );
}
