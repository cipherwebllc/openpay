import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // /tip/[address] は iframe 埋め込みを想定するため、X-Frame-Options を出さず、
  // CSP frame-ancestors で全 origin 許可する。アクションは MetaMask 等のウォレット
  // ポップアップ内で行われるため、iframe 内でのクリックジャッキングは成立しない。
  // /ja/tip/* と /en/tip/* の両方に適用。
  async headers() {
    return [
      {
        source: '/:locale(ja|en)/tip/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
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
  // Prisma など使わないため OpenTelemetry の動的 require 警告を抑制
  disableLogger: true,
  // tunneling は本番で広告ブロック回避用に有効化推奨だが、MVP では無効
  tunnelRoute: undefined,
});
