// Pimlico 残高チェック (scripts/check-pimlico-balance.mjs) の出力の見出し。
// 本番設定の検証 (scripts/verify-production-config.mjs) は Actions のログにこの見出しがあるかで「実際に残高を読んだ」と
// 判定する。以前は両方に文字列を書いていたため、見出しを変えた #599 以降、検証が毎回 fail し続けた (2026-09-28 発覚)。
// 依存ゼロ: 検証の workflow は npm ci をしない (viem を読む check-pimlico-balance.mjs は import できない)。
export const PIMLICO_BALANCE_HEADER = 'Pimlico EntryPoint deposit 残高:';
