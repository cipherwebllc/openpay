// Hero 直下へ昇格したモバイルオーダー訴求バナー (Server Component)。
//
// 画像 public/landing/mobileorder.webp (1280x670) が見出し / 注文フロー / 価値訴求を内包した
// 完成バナーのため、ここでは SEO / a11y 用に読めるテキスト (見出し + リード文 + 画像 alt) と、
// 実際にクリックできる CTA を補う (画像内の文字は検索/読み上げに乗らないため)。主 CTA は店舗作成
// = コンバージョンの /create?tab=mobileOrder、副リンクは解説記事 (note・外部・別タブ)。
// モバイルオーダーは本番公開済 (ENABLE_MOBILE_ORDER ON) ゆえ CTA 先は即機能する。

import Image from 'next/image';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRight, ExternalLink } from 'lucide-react';

// masia02 氏 (運営) による解説記事。外部依存ゆえ参照は1箇所に集約する。
const NOTE_ARTICLE_URL = 'https://note.com/masia02/n/nf19e91b84ef4';

export async function LandingMobileOrder() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');
  const createHref = `/${locale}/create?tab=mobileOrder`;

  return (
    <section className="mt-16 sm:mt-20">
      {/* 差別化の主役 = フィーチャーステージ。emerald の淡い帯で LP 内の「章」として独立させ、
          desktop はテキスト+CTA (左) × 実画面バナー (右) の 2 カラム、mobile は縦積み。 */}
      <div className="overflow-hidden rounded-[2rem] bg-gradient-to-br from-emerald-50 via-teal-50/60 to-emerald-100/40 ring-1 ring-emerald-200/50">
        <div className="grid items-center gap-8 p-6 sm:p-10 lg:grid-cols-[5fr,6fr] lg:gap-12 lg:p-12">
          <div className="text-center lg:text-left">
            <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
              {t('mobileOrderBannerTitle')}
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-600 sm:text-base lg:mx-0">
              {t('mobileOrderBannerLead')}
            </p>
            <div className="mt-7 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center lg:justify-start">
              <Link
                href={createHref}
                prefetch={false}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-emerald-700 hover:shadow-card-hover active:translate-y-0"
              >
                {t('mobileOrderBannerCta')}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <a
                href={NOTE_ARTICLE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white/80 px-6 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200/80 transition-colors hover:bg-white hover:text-emerald-800 hover:ring-emerald-300"
              >
                {t('mobileOrderBannerLearnMore')}
                <ExternalLink className="h-4 w-4" aria-hidden />
              </a>
            </div>
            {/* お客様向けの副導線: やり方ガイド (/guide/mobile-order) と AI 注文ガイド (/guide/agent)。
                店側 CTA の下に控えめなテキストリンクで置く (guide/pos を「使い方」に置くのと同じ体裁)。 */}
            <p className="mt-4 flex flex-col items-center gap-1.5 text-sm sm:flex-row sm:justify-center sm:gap-4 lg:justify-start">
              <Link
                href={`/${locale}/guide/mobile-order`}
                prefetch={false}
                className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
              >
                {t('mobileOrderBannerHowToGuide')}
              </Link>
              <Link
                href={`/${locale}/guide/agent`}
                prefetch={false}
                className="font-medium text-emerald-700 underline underline-offset-2 hover:text-emerald-900"
              >
                {t('mobileOrderBannerAgentGuide')}
              </Link>
            </p>
          </div>

          {/* バナー画像はそのまま主 CTA への大きなクリック領域にする (画像内の擬似ボタンを実リンク化)。
              link の a11y 名は画像 alt が担う (内側に競合する可視テキストは無いので不一致は起きない)。 */}
          <Link
            href={createHref}
            prefetch={false}
            className="group block overflow-hidden rounded-2xl bg-white shadow-lift ring-1 ring-inset ring-emerald-900/10 transition-all duration-200 hover:-translate-y-1 hover:ring-emerald-500/30"
          >
            <Image
              src="/landing/mobileorder.webp"
              alt={t('mobileOrderBannerAlt')}
              width={1280}
              height={670}
              sizes="(min-width: 1024px) 560px, (min-width: 640px) 640px, calc(100vw - 3rem)"
              className="h-auto w-full transition-transform duration-300 group-hover:scale-[1.015]"
            />
          </Link>
        </div>
      </div>
    </section>
  );
}
