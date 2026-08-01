// SEO: robots (Next.js 規約ファイル → /robots.txt)。
// API・admin・動的決済ページ (checkout/pay/order=個別取引 URL) はクロール不要。
// AI クローラも既定で許可 (AIEO: 引用されることが価値)。
import type { MetadataRoute } from 'next';

const SITE_URL = 'https://open-pay.jp';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        // OG 画像 (/api/og/*) は SNS カードクローラーの取得対象。X (Twitterbot) は
        // robots.txt を尊重するため、/api/ 一括 disallow のままだとカード画像の取得を
        // 拒否して X だけカードが出ない (2026-08-01 本番実害・Threads は無視するため表示
        // されて差が出る)。longest-match で allow が勝つよう明示する。
        allow: ['/', '/api/og/'],
        disallow: ['/api/', '/ja/admin/', '/en/admin/', '/ja/checkout', '/en/checkout', '/ja/pay', '/en/pay', '/ja/order', '/en/order'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
