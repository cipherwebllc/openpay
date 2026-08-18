// Sentry クライアント側初期化。Next.js 15.3+ の instrumentation-client.ts として
// ブラウザバンドルの最初に実行される。DSN が未設定なら何もしない (no-op)。
import * as Sentry from '@sentry/nextjs';
import {
  scrubSentryBreadcrumb,
  scrubSentryTransaction,
} from '@/lib/telemetryRedaction';

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
    ignoreErrors: [
      /Non-Error promise rejection captured/,
      // 同族の兄弟パターン: 拒否理由が DOM Event のとき Sentry は上とは別の文言
      // 「Event `Event` (type=error) captured as promise rejection」を生成し、上の
      // フィルタをすり抜ける (2026-08-18 mainnet 実観測: 存在しない /en/faq への
      // 旧 UA Chrome 123 アクセスの 404 上・スタックなし・非アクショナブル)。
      // script/リソース読込失敗の promise 化やウォレット拡張が典型で、自前コードは
      // Error 以外で reject しないため実シグナルは落ちない。
      /captured as promise rejection/,
      // ウォレット拡張/SDK の接続・再接続失敗 (MetaMask 等)。ページ読込時の自動再接続
      // (wagmi reconnectOnMount=true) や、ロック中/権限未付与/接続キャンセルのウォレットで
      // 日常的に発生する。スタックはウォレット拡張内 (chrome-extension://…/inpage.js) を指し
      // 自前コードのバグではない。接続エラーは UI (ConnectButton) が表示・回復させるため、
      // Sentry のアラートとしては非アクショナブルなノイズ。実ユーザ報告 (2026-06-17 mainnet・
      // 東京 Win/Chrome) で "Error restoring session: Failed to connect to MetaMask" が上がるため drop。
      /MetaMask extension not found/i,
      /Failed to connect to MetaMask/i,
      /Error restoring session/i,
    ],
    // ブラウザ拡張 (ウォレット/広告ブロッカー/パスワードマネージャ等) が注入したスクリプト由来の
    // エラーは自前アプリのバグではない。スタック該当フレームの URL が拡張スキームのイベントを drop。
    // 自前バンドル (https://…/_next/…) は対象外なので実シグナルは落とさない。
    denyUrls: [/^chrome-extension:\/\//i, /^moz-extension:\/\//i, /^safari-(web-)?extension:\/\//i],
    tracesSampleRate: parseSampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      1.0,
    ),
    // fetch/xhr/navigation breadcrumb と BrowserTracing span の URL は origin だけを残す。
    // webhook token 等が path/query/userinfo に含まれても Sentry へ送らない。
    beforeBreadcrumb: scrubSentryBreadcrumb,
    beforeSendTransaction: scrubSentryTransaction,
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
