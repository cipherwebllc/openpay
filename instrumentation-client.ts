// Sentry クライアント側初期化。Next.js 15.3+ の instrumentation-client.ts として
// ブラウザバンドルの最初に実行される。DSN が未設定なら何もしない (no-op)。
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'unknown',
    tracesSampleRate: 1.0,
    // PII (IP / ユーザ ID) は送らない。但しウォレットアドレスは breadcrumb
    // に出る可能性があるので、本当に厳格にしたい場合は beforeSend で scrub。
    sendDefaultPii: false,
    // Replay: ユーザ操作の動画 (DOM mutation + console + network) を送信。
    // 通常 10% サンプリング、エラー発生 session は 100% (バグ再現に直結)。
    // テキスト/メディア共に mask 既定 ON でアドレス・金額入力が露出しない。
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
  });
}

export const onRouterTransitionStart = dsn
  ? Sentry.captureRouterTransitionStart
  : () => undefined;
