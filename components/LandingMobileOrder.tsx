// 「使い方」直下のモバイルオーダー訴求バナー (Server Component)。
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
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('mobileOrderBannerTitle')}
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
          {t('mobileOrderBannerLead')}
        </p>
      </div>

      {/* バナー画像はそのまま主 CTA への大きなクリック領域にする (画像内の擬似ボタンを実リンク化)。
          link の a11y 名は画像 alt が担う (内側に競合する可視テキストは無いので不一致は起きない)。 */}
      <Link
        href={createHref}
        prefetch={false}
        className="group mx-auto mt-6 block max-w-3xl overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-inset ring-slate-200/60 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift hover:ring-brand/30"
      >
        <Image
          src="/landing/mobileorder.webp"
          alt={t('mobileOrderBannerAlt')}
          width={1280}
          height={670}
          sizes="(min-width: 768px) 768px, calc(100vw - 2rem)"
          className="h-auto w-full"
        />
      </Link>

      <div className="mt-6 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
        <Link
          href={createHref}
          prefetch={false}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700"
        >
          {t('mobileOrderBannerCta')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
        <a
          href={NOTE_ARTICLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-brand/40 hover:text-brand-dark"
        >
          {t('mobileOrderBannerLearnMore')}
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      </div>
    </section>
  );
}
