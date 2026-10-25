// ページ名だけで <title> を決める route 用の metadata ビルダー。
// 以前は generateMetadata の無いページが app/[locale]/layout.tsx の総合 title (トップと同じ) を継承していた。
// 型は料金ページなどと同じ「〇〇 | OpenPay」。generateMetadata は layout.tsx に置く: これらの page.tsx の多くは
// 'use client' で metadata を export できず、page.tsx に規定外の export を足さない (掟 3) ためにも layout が受け皿になる。
// 文言は画面の見出しと同じ messages の既存キーから取る (新しい文言は作らない)。

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { guidePageMetadata } from '@/lib/guideMetadata';

const SITE_NAME = 'OpenPay';

export function titleWithSite(name: string): string {
  return `${name} | ${SITE_NAME}`;
}

export async function routeMetadata(opts: {
  locale: string;
  /** locale prefix を含まないパス (例 '/terms') */
  path: string;
  /** ページ名。messages の既存キー ({ namespace, key }) か、messages に無い名前の固定文字列 (ja / en)。 */
  name: { namespace: string; key: string } | { ja: string; en: string };
  /** 検索に出さない画面 (個別の取引・店内モニター等)。canonical / OG は付けない。 */
  noindex?: boolean;
}): Promise<Metadata> {
  const locale = opts.locale === 'en' ? 'en' : 'ja';
  let pageName: string;
  if ('namespace' in opts.name) {
    const t = await getTranslations({ locale, namespace: opts.name.namespace });
    pageName = t(opts.name.key);
  } else {
    pageName = opts.name[locale];
  }
  const title = titleWithSite(pageName);
  if (opts.noindex) return { title, robots: { index: false, follow: false } };
  const tMeta = await getTranslations({ locale, namespace: 'Meta' });
  return guidePageMetadata({ locale, path: opts.path, title, description: tMeta('description') });
}
