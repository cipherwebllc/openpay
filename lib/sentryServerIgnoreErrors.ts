// server (instrumentation.ts の Sentry.init) で Sentry に送らない error。どれも「何を止めるか・なぜこちらの不具合でないか」を
// 書き、足すときはテスト (tests/lib/sentryServerIgnoreErrors.test.ts) も足す。ブラウザ側は instrumentation-client.ts の ignoreErrors。
//
// - 壊れた router state header: Next.js の client (ブラウザ) は正しい形しか送らない。壊れた形を送るのは、ブラウザでない
//   自動の接続元 (2026-11-24: Azure の 1 つの接続元が /ja/store に送っていた) で、Next.js がその要求を断るだけ。
//   文言は next/dist/server/app-render/parse-and-validate-flight-router-state.js の E10 と完全一致 (同じ所の「複数」「大きすぎ」や
//   ほかの error は止めない)。
//   E10 は JSON でないときだけでなく、形の検査に落ちたときも出る。Next.js を上げた直後に古いタブ (古い client) が新しい server に
//   送る形の合わない header も、同じ文言で Sentry に出なくなる。そのときお客様は、その 1 回の遷移がページ全体の読み込みに
//   切り替わるだけ (Next.js の client は 200 でない応答でふつうの読み込みにする)。Next.js を上げた後は Vercel のログの 500 を見る。
export const SENTRY_SERVER_IGNORE_ERRORS: readonly RegExp[] = [
  /^The router state header was sent but could not be parsed\.$/,
];
