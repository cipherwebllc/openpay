import { sentryEnvironment } from '@/lib/sentryEnvironment';
import {
  scrubSentryServerEvent,
  scrubSentryServerTransaction,
} from '@/lib/telemetryRedaction';

const sentryPrivacyOptions = {
  // SDK が query_string / url.query を生成する入口も止め、scrubber は既存 event
  // や SDK 由来の別表現を落とす二段構えにする。
  dataCollection: { urlQueryParams: false },
  beforeSend: scrubSentryServerEvent,
  beforeSendTransaction: scrubSentryServerTransaction,
};

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
      // Vercel の Node 実行環境は VERCEL=1 を持つ (build・runtime とも)。無いのは手元の dev / next start だけ
      // なので local-<network> にして本番の通知に混ぜない。edge は VERCEL の有無を確かめていないので変えない
      // (本番を local と誤って付けて通知から漏らす方が害が大きい)。
      environment: sentryEnvironment(process.env.NEXT_PUBLIC_NETWORK_ENV, !process.env.VERCEL),
      tracesSampleRate: 1.0,
      ...sentryPrivacyOptions,
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'unknown',
      tracesSampleRate: 1.0,
      ...sentryPrivacyOptions,
    });
  }
}

export async function onRequestError(...args: Parameters<typeof import('@sentry/nextjs').captureRequestError>) {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
}
