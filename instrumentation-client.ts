// Sentry クライアント側初期化。Next.js 15.3+ の instrumentation-client.ts として
// ブラウザバンドルの最初に実行される。DSN が未設定なら何もしない (no-op)。
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'unknown',
    // 本番では tracesSampleRate を下げてコスト最適化を推奨
    tracesSampleRate: 1.0,
    // 取得した PII は最小限に (アドレスは IP に置換される可能性)
    sendDefaultPii: false,
  });
}

export const onRouterTransitionStart = dsn
  ? Sentry.captureRouterTransitionStart
  : () => undefined;
