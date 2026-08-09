// SEO: サイトマップ (Next.js 規約ファイル → /sitemap.xml)。
// 公開・インデックス価値のある静的 route のみ列挙する (checkout/pay/order 等の
// 動的決済ページ・admin・API は載せない)。@handle はユーザ生成のため対象外。
import type { MetadataRoute } from 'next';
import { LOCALES } from '@/i18n';

const SITE_URL = 'https://open-pay.jp';

// locale 配下の公開 route ('' = LP)
const PUBLIC_ROUTES = [
  '',
  '/create',
  '/scan',
  '/history',
  '/explore',
  '/store',
  '/kit',
  '/discovery',
  '/directory',
  '/news',
  '/transparency',
  '/guide/start',
  '/guide/pos',
  '/guide/qr',
  '/guide/shop',
  '/guide/agent',
  '/guide/mobile-order',
  '/guide/ai-pay',
  '/guide/sell',
  '/guide/store',
] as const;

// 法務ページ。検索価値は低いが「サービス名 + 特商法/利用規約」で調べる
// 慎重な利用者に公式整備済みであることを示す信頼シグナルとして低 priority で載せる。
const LEGAL_ROUTES = ['/terms', '/privacy', '/disclaimer', '/tokutei'] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return LOCALES.flatMap((locale) => [
    ...PUBLIC_ROUTES.map((route) => ({
      url: `${SITE_URL}/${locale}${route}`,
      changeFrequency: route === '' ? ('weekly' as const) : ('monthly' as const),
      priority: route === '' ? 1 : 0.6,
    })),
    ...LEGAL_ROUTES.map((route) => ({
      url: `${SITE_URL}/${locale}${route}`,
      changeFrequency: 'monthly' as const,
      priority: 0.3,
    })),
  ]);
}
