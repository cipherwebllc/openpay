// Sentry クライアント側初期化。Next.js 15.3+ の instrumentation-client.ts として
// ブラウザバンドルの最初に実行される。DSN が未設定なら何もしない (no-op)。
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (!dsn && process.env.NODE_ENV === 'production') {
  // production で DSN 未設定 = browser 側 Sentry が無効 (alert rule 不発火)。
  // 設定漏れを開発者が devtools で気付けるよう production 限定で warn。
  console.warn(
    '[sentry] NEXT_PUBLIC_SENTRY_DSN not set in production — browser events will NOT be sent. Configure in Vercel project env vars (see docs/DEPLOY_CHECKLIST.md §8).',
  );
}

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
    // 注入ウォレット拡張 (MetaMask/Rabby/Coinbase) や WalletConnect/Coinbase SDK は
    // 内部 promise を Error でない値 (undefined / [object Object] 等) で reject することがあり、
    // それが onunhandledrejection でグローバルに漏れて "Non-Error promise rejection captured
    // with value: ..." として上がる。スタックがアプリ内を指さず .catch でも塞げない非アクショ
    // ナブルなノイズ (同族に Outlook SafeLink の "Object Not Found Matching Id" 等) なので、
    // この family をまとめて drop してアラートを汚さない。自前コードは例外を必ず Error で
    // 投げる (throw new Error(...)) ため、実シグナルの取りこぼしリスクは実質ゼロ。
    ignoreErrors: [/Non-Error promise rejection captured/],
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
