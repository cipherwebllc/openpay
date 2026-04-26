// Next.js のサーバーサイド instrumentation エントリ。
// runtime ごとに Sentry の SDK サブセットを動的読込する。
export async function register(): Promise<void> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

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
