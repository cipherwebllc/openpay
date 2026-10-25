// Hero。Server Component。
// 5 秒で「誰向けか」が分かるように、主役をお店にする (2026-10-25 user 指摘: お店・お客様・クリエイター・AI 開発者の話が
// 全部入っていて誰向けか分からない)。見出しはお店向け・主ボタンは 1 つ (決済QRを作る)・お店以外の方には状態を持たない
// 1 行のリンクで入口を渡す (タブにすると client JS と CLS が増え、訪問者は押さない・plans/lp-polish-2026-10-25.md)。
// 「0円〜」の条件 (お客様がガス代を払う通常決済) は副文の同じ文に置く (永続の約束にしない・比較表と同じ考え方)。
// スマホは文字 → ボタン → 入口 → 写真の順にして、ボタンを 1 画面目に入れる。PC は左に文字・右に写真の 2 列。

import Image from 'next/image';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowDown, ArrowRight } from 'lucide-react';
import { env } from '@/lib/env';
import { guideNavFor } from '@/lib/guideNav';

export async function LandingHero() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');
  // 入口の名前はガイドの目次の分け方 (お店向け / お客様向け / クリエイター向け / AI・開発者向け) と同じ語を使う。
  const { groups } = guideNavFor(locale);
  const groupTitle = (id: string) => groups.find((g) => g.id === id)?.title ?? '';
  const audiences = [
    // クリエイターと AI・開発者はこのページの節へ (販売・AI の節に入口がそろっている)。販売の節は Store の flag が
    // OFF だと描かれないので、そのときは販売のガイドへ。お客様はトップの読者ではないので支払い方のガイドへ
    // (スキャンの入口はヘッダとガイドにある)。
    env.enableCreatorStoreUi
      ? { key: 'creators', href: '#lp-sell', label: groupTitle('creators'), inPage: true }
      : { key: 'creators', href: `/${locale}/guide/store`, label: groupTitle('creators'), inPage: false },
    { key: 'ai', href: '#lp-ai', label: groupTitle('ai'), inPage: true },
    { key: 'customers', href: `/${locale}/guide/pay`, label: groupTitle('customers'), inPage: false },
  ];

  return (
    <section className="relative">
      {/* 装飾: 上部からの淡いブランドグロー (奥行き + 温度感)。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-16 -z-10 mx-auto h-72 max-w-3xl bg-[radial-gradient(60%_60%_at_50%_0%,rgba(59,130,246,0.16),transparent_72%)]"
      />
      <div className="mx-auto grid max-w-5xl items-center gap-9 pt-4 sm:pt-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-12 lg:pt-12">
        <div className="text-center lg:text-left">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-blue-200/70 bg-blue-50/90 px-3 py-1 text-xs font-semibold tracking-wide text-brand">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />
            {t('tagline')}
          </p>
          <h2 className="mt-5 text-[2.25rem] font-bold leading-[1.1] tracking-[-0.02em] text-slate-900 [word-break:auto-phrase] text-balance sm:text-5xl lg:text-[3rem]">
            {t('heroLeadline')}
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-balance text-[15px] leading-relaxed text-slate-600 [word-break:auto-phrase] sm:text-base lg:mx-0">
            {t('heroBody')}
          </p>
          <div className="mt-7 flex justify-center lg:justify-start">
            <Link
              href={`/${locale}/create`}
              prefetch={false}
              className="group inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-brand px-6 text-base font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-[0.99]"
            >
              {t('heroCta')}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </div>
          {/* お店以外の方の入口。リンク名は見えている文字 (掟 8)。 */}
          <nav aria-labelledby="lp-hero-audience" className="mt-7">
            <p id="lp-hero-audience" className="text-xs font-semibold text-slate-500">
              {t('heroAudienceLead')}
            </p>
            {/* 主ボタンより軽く見せるため、枠のない文字のリンクを 1 行に並べる (押せる高さは 40px)。 */}
            <ul className="flex flex-wrap justify-center gap-x-4 lg:justify-start">
              {audiences.map(({ key, href, label, inPage }) => (
                <li key={key}>
                  <Link
                    href={href}
                    prefetch={false}
                    className="inline-flex min-h-10 items-center gap-1 text-[13px] font-semibold text-brand underline-offset-4 hover:underline sm:text-sm"
                  >
                    {label}
                    {inPage ? (
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="overflow-hidden rounded-[1.75rem] bg-white shadow-lift ring-1 ring-slate-200/60">
          <Image
            src="/landing/hero-overview.avif"
            alt={t('heroVisualAlt')}
            width={1400}
            height={787}
            priority
            sizes="(min-width: 1024px) 560px, calc(100vw - 2rem)"
            className="h-auto w-full object-cover"
          />
        </div>
      </div>
    </section>
  );
}
