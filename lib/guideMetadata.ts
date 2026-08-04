// guide/* 共通の metadata ビルダー (P5・plans/site-ia-guides-ruling.md N9)。
// ページ固有の title/description を OG/Twitter にも反映し、canonical + hreflang
// (ja/en) を明示する。alternates は layout に置くと全下層が canonical=/ja になる
// 事故を招くため (app/[locale]/layout.tsx 参照)、ページ単位でここから設定する。
// ⚠️ openGraph を子で設定すると layout の og-image 継承が丸ごと消えるため、
// images は必ず明示する (省略時は現行トップの og-image.png)。

import type { Metadata } from 'next';

export type GuideOgImage = {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
};

export function guidePageMetadata(opts: {
  locale: string;
  /** locale prefix を含まないパス (例 '/guide/pos') */
  path: string;
  title: string;
  description: string;
  ogImage?: GuideOgImage;
}): Metadata {
  // 未知ロケールは ja に正規化 (contentFor の fallback と同じ規約)。
  // 正規化しないと canonical が /fr/... 等の存在しない URL になる。
  const locale = opts.locale === 'en' ? 'en' : 'ja';
  const image: GuideOgImage = opts.ogImage ?? {
    url: '/og-image.png',
    width: 1200,
    height: 630,
    alt: opts.title,
  };
  return {
    title: opts.title,
    description: opts.description,
    alternates: {
      canonical: `/${locale}${opts.path}`,
      languages: {
        ja: `/ja${opts.path}`,
        en: `/en${opts.path}`,
      },
    },
    openGraph: {
      title: opts.title,
      description: opts.description,
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title: opts.title,
      description: opts.description,
      images: [image.url],
    },
  };
}
