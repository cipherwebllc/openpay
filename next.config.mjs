import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // OG 画像ルート (/api/og/tip, /api/og/handle) は実行時に fs で日本語フォントと
  // ブランドアイコンを読む。serverless 関数バンドルに確実に含めるため出力ファイル
  // トレースに明示追加する (動的 path の fs 読込は nft が自動検出できないため)。
  outputFileTracingIncludes: {
    '/api/og/tip': ['./app/api/og/fonts/**', './public/icon-512.png'],
    '/api/og/handle': ['./app/api/og/fonts/**', './public/icon-512.png'],
  },
  // frame 方針は default-deny: /tip/[address] だけが iframe 埋め込みを想定するため
  // frame-ancestors * を許可し (アクションは MetaMask 等のウォレットポップアップ内で
  // 行われるため、iframe 内でのクリックジャッキングは成立しない)、それ以外の全ページ
  // (/pay /checkout /create /history /scan 等) は同一 origin に限定する。Next.js は
  // 既定で X-Frame-Options を出さないため、明示しない限り任意 origin から iframe 化
  // できてしまう。2 つ目の source は negative lookahead で /ja/tip・/en/tip 配下を
  // 除外 (重複 match させると tip 側にも X-Frame-Options が付き、CSP を見ない古い
  // 実装で埋め込みが壊れるため、排他に分ける)。
  async headers() {
    return [
      {
        source: '/:locale(ja|en)/tip/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
        ],
      },
      {
        source: '/((?!(?:ja|en)/tip(?:/|$)).*)',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
  webpack: (config) => {
    // wagmi / viem / walletconnect の依存が一部 Node-only モジュールを参照するため、
    // クライアントバンドルでは無効化する
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    // MetaMask SDK は React Native 用に @react-native-async-storage を optional 参照する。
    // Web ビルドでは存在しないので空モジュールへエイリアスする。
    config.resolve.alias = {
      ...config.resolve.alias,
      '@react-native-async-storage/async-storage': false,
    };
    config.externals.push('pino-pretty', 'lokijs', 'encoding');
    return config;
  },
};

// Sentry: source map upload は SENTRY_AUTH_TOKEN がある時のみ有効。
// 未設定でも他の機能 (instrumentation の自動取込み等) は動作する。
// SENTRY_AUTH_TOKEN は build-time 専用 secret。Vercel Dashboard では必ず
// "Sensitive Environment Variables" として登録すること (NEXT_PUBLIC_* 系
// と異なり client bundle には含まれない / 漏洩すると source map upload
// 権限を取られる)。詳細は README "Vercel デプロイ" セクション参照。
export default withSentryConfig(withNextIntl(nextConfig), {
  silent: !process.env.CI,
  // Sentry SDK の debug logger 文をバンドルから tree shake で除去。
  // 旧 `disableLogger` は v10 で deprecated、v11 で削除予定。
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
  // tunneling は本番で広告ブロック回避用に有効化推奨だが、MVP では無効
  tunnelRoute: undefined,
});
