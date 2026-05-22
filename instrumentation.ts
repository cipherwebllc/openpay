// Next.js のサーバーサイド instrumentation エントリ。
// runtime ごとに Sentry の SDK サブセットを動的読込する。
export async function register(): Promise<void> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    // production で DSN 未設定 = alert rule (DEPLOY_CHECKLIST §3.2) が永遠に
    // 発火しない silent failure。Vercel function logs に visible warn を残し
    // 設定漏れを検知可能にする。dev / test では noisy なので production 限定。
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[sentry] NEXT_PUBLIC_SENTRY_DSN not set in production — server/edge events will NOT be sent. Configure in Vercel project env vars (see docs/DEPLOY_CHECKLIST.md §8).',
      );
    }
    return;
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'unknown',
      tracesSampleRate: 1.0,
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'unknown',
      tracesSampleRate: 1.0,
    });
  }
}

export async function onRequestError(...args: Parameters<typeof import('@sentry/nextjs').captureRequestError>) {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
}
