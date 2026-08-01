// SEO: robots (Next.js 規約ファイル → /robots.txt)。
// API・admin・動的決済ページ (checkout/pay/order=個別取引 URL) はクロール不要。
// AI クローラも既定で許可 (AIEO: 引用されることが価値)。
import type { MetadataRoute } from 'next';

const SITE_URL = 'https://open-pay.jp';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        // X の Card Validator は longest-match を評価せず「Disallow: /api/ が前置
        // 一致したら警告」する crude 実装が疑われる (2026-08-02 実測: allow 追加後も
        // WARN 継続)。UA 専用グループがあるとそのボットは * グループを参照しない
        // (RFC 9309) ため、Twitterbot には Disallow を一切見せず確実に許可する。
        // Twitterbot はツイートされた URL とカード画像しか取得しないため全許可で害なし。
        userAgent: 'Twitterbot',
        allow: '/',
      },
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
