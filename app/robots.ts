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
        allow: '/',
        disallow: ['/api/', '/ja/admin/', '/en/admin/', '/ja/checkout', '/en/checkout', '/ja/pay', '/en/pay', '/ja/order', '/en/order'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
