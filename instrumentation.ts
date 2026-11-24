import { sentryEnvironment } from '@/lib/sentryEnvironment';
import { SENTRY_SERVER_IGNORE_ERRORS } from '@/lib/sentryServerIgnoreErrors';
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

// こちらの不具合でない server の error を Sentry に送らない (一覧と理由は lib/sentryServerIgnoreErrors.ts)。
const sentryServerFilterOptions = {
  ignoreErrors: [...SENTRY_SERVER_IGNORE_ERRORS],
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
      ...sentryServerFilterOptions,
      // 受けた request の本文を event に採らない (既定の 'medium' は約 10 KB まで採る)。出品の有料の本文・納品 URL・
      // 署名などを第三者 (Sentry) へ波及させない。lib/telemetryRedaction.ts でも request.data を消す (二段構え)。
      // disableIncomingRequestSpans は @sentry/nextjs の既定の Http の設定 (受けた request は Next.js が計測する・二重にしない)。
      // 同じ名前の integration を渡すと既定を置き換えるので、既定の値も一緒に書く。
      integrations: [Sentry.httpIntegration({ disableIncomingRequestSpans: true, maxIncomingRequestBodySize: 'none' })],
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'unknown',
      tracesSampleRate: 1.0,
      ...sentryPrivacyOptions,
      ...sentryServerFilterOptions,
    });
  }
}

export async function onRequestError(...args: Parameters<typeof import('@sentry/nextjs').captureRequestError>) {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
}
