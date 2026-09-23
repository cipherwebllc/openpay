import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

// Browser transports in lib/chains.ts (including viem/chains defaults), plus
// lib/resolveAddress.ts. Keep mainnet + testnet for wallet/network switching.
const rpcOrigins = [
  'https://mainnet.base.org', 'https://sepolia.base.org',
  'https://arb1.arbitrum.io', 'https://sepolia-rollup.arbitrum.io',
  'https://mainnet.optimism.io', 'https://sepolia.optimism.io',
  'https://polygon.drpc.org', 'https://polygon-amoy.drpc.org',
  'https://public-en.node.kaia.io', 'https://public-en-kairos.node.kaia.io',
  'https://api.avax.network', 'https://api.avax-test.network',
  'https://rpc.mainnet.arc.io', 'https://rpc.testnet.arc.io',
  'https://mainnet.unichain.org', 'https://sepolia.unichain.org',
  'https://worldchain-mainnet.g.alchemy.com', 'https://worldchain-sepolia.g.alchemy.com',
  'https://rpc.soniclabs.com', 'https://rpc.blaze.soniclabs.com',
  'https://evm-rpc.sei-apis.com', 'https://evm-rpc-testnet.sei-apis.com',
  'https://rpc.hyperliquid.xyz', 'https://rpc.hyperliquid-testnet.xyz',
  'https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com',
  'https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.ankr.com',
];

const walletVerifyOrigins = [
  'https://verify.walletconnect.org', 'https://verify.walletconnect.com',
];
const connectOrigins = [
  ...rpcOrigins,
  // lib/wagmi.ts → @walletconnect/core + @reown/appkit-common ConstantsUtil.
  'wss://relay.walletconnect.org', 'https://rpc.walletconnect.org',
  'https://pulse.walletconnect.org', 'https://api.web3modal.org',
  'https://echo.walletconnect.com', ...walletVerifyOrigins,
  // lib/wagmi.ts → @coinbase/wallet-sdk core/constants, initCCA and WalletLinkWebSocket.
  'https://www.walletlink.org', 'wss://www.walletlink.org',
  'https://rpc.wallet.coinbase.com', 'https://cca-lite.coinbase.com',
  // lib/pimlico.ts, lib/crossChain/config.ts and lib/crossChain/cctp.ts.
  'https://api.pimlico.io',
  'https://gateway-api.circle.com', 'https://gateway-api-testnet.circle.com',
  'https://iris-api.circle.com', 'https://iris-api-sandbox.circle.com',
];

const frameOrigins = [
  // lib/handle.ts extractHandleEmbed rebuilds URLs for these nine providers.
  'https://www.youtube-nocookie.com', 'https://open.spotify.com',
  'https://embed.nicovideo.jp', 'https://player.vimeo.com',
  'https://embed.music.apple.com', 'https://www.tiktok.com',
  'https://suno.com', 'https://w.soundcloud.com', 'https://audius.co',
  // lib/wagmi.ts → WalletConnect Verify and Reown's auth iframe.
  ...walletVerifyOrigins, 'https://secure.walletconnect.org',
];

function configuredConnectOrigins() {
  // lib/env.ts public RPC overrides and instrumentation-client.ts's Sentry DSN.
  // Only the origin belongs in a public header, never DSN keys or RPC URL tokens.
  return Object.entries(process.env).flatMap(([key, value]) => {
    if (!(/^NEXT_PUBLIC_[A-Z_]+_RPC_URL$/.test(key) || key === 'NEXT_PUBLIC_SENTRY_DSN') || !value) return [];
    // Isolate malformed optional RPC/telemetry configuration from page delivery:
    // omit invalid sources from this observational policy, not from the app config.
    // The character check also keeps CSP separators out of the response header.
    try {
      const { origin } = new URL(value);
      return /^https?:\/\/[a-z0-9_.[\]:-]+$/i.test(origin) ? [origin] : [];
    } catch {
      return [];
    }
  });
}

function reportOnlyCsp() {
  const isDev = process.env.NODE_ENV === 'development';
  // C17 / D6: observe for 1–2 weeks, then review enforcement in a separate PR.
  // Next 15.5.25 nonces require dynamic rendering (including the static locale
  // layout): https://nextjs.org/docs/15/app/guides/content-security-policy
  // Use a host allowlist without changing rendering/caching. Next's inline RSC
  // hydration and Coinbase's inline telemetry will intentionally report; resolve
  // those with a nonce/hash design before enforcing, not a fixed/reused nonce.
  // No collector/report-uri: observations are in browser DevTools only. A public
  // collector needs bounded ingestion/redaction/rate limiting; logger.info is
  // suppressed at the default log level. Do not send CSP reports to Sentry/KV.
  // Merchant webhooks (TipForm/CheckoutForm) and ENS CCIP-read URLs are open-ended;
  // observe these rather than granting all HTTPS connections before review.
  return [
    "default-src 'self'",
    // app/[locale]/layout.tsx: Vercel scripts are same-origin in production.
    // Next.js App Router inlines RSC payload scripts (self.__next_f.push) on every page.
    // Without a per-request nonce (which would force dynamic rendering of every page),
    // script-src must allow inline scripts or every page reports a violation (Lighthouse
    // inspector-issues failed on all 7 URLs, PR #577). External script hosts stay
    // disallowed. A nonce-based policy is evaluated in the enforcement PR.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval' https://va.vercel-scripts.com" : ''}`,
    "script-src-attr 'none'",
    // React style props and the wallet modal inject inline CSS.
    "style-src 'self' 'unsafe-inline'",
    // HandleProfile, storefronts, MobileOrderView and AccountingAffiliates accept
    // third-party HTTPS images. Their explicit referrerPolicy=no-referrer stays.
    "img-src 'self' https: data: blob:",
    // components/handleFonts.ts uses next/font/google: fonts are self-hosted.
    "font-src 'self'",
    `connect-src 'self' ${[...new Set([...connectOrigins, ...configuredConnectOrigins()])].join(' ')}${isDev ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    `frame-src 'self' ${frameOrigins.join(' ')}`,
    // hooks/useQrScanner.ts → qr-scanner's blob worker; public/sw.js is self.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // frame-ancestors remains exclusively in the existing enforced CSP below.
  ].join('; ');
}

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
  // ⚠️ rewrites() をここに定義しないこと: rewrites が 1 つでも存在すると client
  // router に rewrite 解決コードが入り、全ルートの First Load JS が +3kB 太って
  // bundle 予算を割る (2026-08-02 実測)。OG 画像の /og/* → /api/og/* 転送は
  // middleware.ts で server rewrite している (client 影響ゼロ)。
  // frame 方針は default-deny: /tip/[address] だけが iframe 埋め込みを想定するため
  // frame-ancestors * を許可し (アクションは MetaMask 等のウォレットポップアップ内で
  // 行われるため、iframe 内でのクリックジャッキングは成立しない)、それ以外の全ページ
  // (/pay /checkout /create /history /scan 等) は同一 origin に限定する。Next.js は
  // 既定で X-Frame-Options を出さないため、明示しない限り任意 origin から iframe 化
  // できてしまう。default-deny 側の source は negative lookahead で /ja/tip・/en/tip 配下を
  // 除外 (重複 match させると tip 側にも X-Frame-Options が付き、CSP を見ない古い
  // 実装で埋め込みが壊れるため、排他に分ける)。
  async headers() {
    return [
      {
        source: '/:path*',
        // Next 15's Node runtime preserves config headers over same-named route
        // response headers. Route-specific exceptions need a later config rule
        // too (see delivery below); setting a header in the route alone won't win.
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Element-level no-referrer overrides this default; no attributes change.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // /scan → hooks/useQrScanner.ts needs camera access from our own origin.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), display-capture=()' },
          { key: 'Content-Security-Policy-Report-Only', value: reportOnlyCsp() },
          // HSTS is owned by Vercel (default max-age=63072000), possibly overridden
          // by Cloudflare. Avoid a competing value/includeSubDomains/preload here:
          // https://vercel.com/docs/headers/response-headers#strict-transport-security
        ],
      },
      {
        source: '/api/store/delivery/:path*',
        // Next 15 sendResponse preserves an already-set config header. Keep the
        // route's stricter policy here too so the global default cannot leak a
        // sensitive delivery URL via a redirect's Referer (app/api/store/delivery).
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
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
