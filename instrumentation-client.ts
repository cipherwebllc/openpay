// Sentry クライアント側初期化。Next.js 15.3+ の instrumentation-client.ts として
// ブラウザバンドルの最初に実行される。DSN が未設定なら何もしない (no-op)。
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

// 0.0〜1.0 の浮動小数。範囲外/不正値はフォールバックを使う。
function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_NETWORK_ENV ?? 'unknown',
    tracesSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      1.0,
    ),
    // PII (IP / ユーザ ID) は送らない。但しウォレットアドレスは breadcrumb
    // に出る可能性があるので、本当に厳格にしたい場合は beforeSend で scrub。
    sendDefaultPii: false,
    // Replay: ユーザ操作の動画 (DOM mutation + console + network) を送信。
    // 通常 10% サンプリング、エラー発生 session は 100% (バグ再現に直結)。
    // テキスト/メディア共に mask 既定 ON でアドレス・金額入力が露出しない。
    // トラフィック増加でコスト spike するため env で再デプロイなしに調整可能。
    replaysSessionSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE,
      0.1,
    ),
    replaysOnErrorSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE,
      1.0,
    ),
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
