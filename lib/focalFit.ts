// LP のビッグナンバー (focal) は 1 行固定 (whitespace-nowrap) で、2 列 / 4 列のカードに置く。
// 固定の文字サイズだと、長い文言 (en "No sign-up"・"Seconds"、ja "登録不要" 等) が狭いカードから
// はみ出し、スマホでは文書幅まで広げていた (2026-09-26 実測: /en 390px で 411px)。
// カードを container (inline-size) にして、文字サイズを「設計上の最大」と「カード幅に収まる大きさ
// (cqi)」の小さい方にする。収まる大きさは文言の幅を em で見積もって決める。
//
// 見積もりは実フォントより少し大きめ (= 必ず収まる側) に倒す。実測 (Chromium・本番フォント) との比:
//   "No sign-up" 実 5.22em / 見積 6.02em、"Seconds" 4.15 / 4.39、"登録不要" 4.0 / 4.24、"JPYC 1%" 4.2 / 4.77。

/** 文言の幅を em で見積もる (CJK・全角 1em・% 0.9em・英小文字 0.58em・空白 0.3em・その他 0.66em に 6% の余裕)。 */
export function estimateFocalEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2e80) em += 1;
    else if (ch === '%') em += 0.9;
    else if (ch === ' ') em += 0.3;
    else if (ch >= 'a' && ch <= 'z') em += 0.58;
    else em += 0.66;
  }
  return em * 1.06;
}

/** カード (container) の内幅に収まる文字サイズ。CSS 変数 --focal-fit に入れて min() で上限と組み合わせる。 */
export function focalFitCqi(text: string): string {
  return `${(100 / Math.max(estimateFocalEm(text), 1)).toFixed(2)}cqi`;
}
