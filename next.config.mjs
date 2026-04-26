import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  // Prisma など使わないため OpenTelemetry の動的 require 警告を抑制
  disableLogger: true,
  // tunneling は本番で広告ブロック回避用に有効化推奨だが、MVP では無効
  tunnelRoute: undefined,
});
