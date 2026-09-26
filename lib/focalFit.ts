// LP のビッグナンバー (focal) は 1 行固定 (whitespace-nowrap) で、2 列 / 4 列のカードに置く。
// 固定の文字サイズだと、長い文言 (en "No sign-up"・"Seconds"、ja "登録不要" 等) が狭いカードから
// はみ出し、スマホでは文書幅まで広げていた (2026-09-26 実測: /en 390px で 411px)。
// カードを container (inline-size) にして、文字サイズを「設計上の最大」と「カード幅に収まる大きさ
// (cqi)」の小さい方にする。収まる大きさは文言の幅を em で見積もって決める。
//
// 本文は OS 標準書体 (app/globals.css の system-ui スタック) なので、字幅は環境で変わる。見積もりは
// 字幅の広い書体 (Linux の DejaVu Sans Bold・CI の e2e 環境) でも収まる側に倒す。見積もりと実幅 (em):
//   "No sign-up" 見積 7.23 / Mac 5.22 / DejaVu 約 6.08、"Seconds" 5.28 / 4.15 / 約 4.70、
//   "登録不要" 4.24 / 4.0、"JPYC 1%" 5.58 / 4.2 / 約 4.68。
// それでも収まらない未知の書体では、空白で折り返す (whitespace-nowrap を付けない) のが最後の保険。

/** 文言の幅を em で見積もる (CJK・全角 1em・% 1em・英小文字 0.7em・空白 0.36em・その他 0.78em に 6% の余裕)。 */
export function estimateFocalEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2e80) em += 1;
    else if (ch === '%') em += 1;
    else if (ch === ' ') em += 0.36;
    else if (ch >= 'a' && ch <= 'z') em += 0.7;
    else em += 0.78;
  }
  return em * 1.06;
}

/** カード (container) の内幅に収まる文字サイズ。CSS 変数 --focal-fit に入れて min() で上限と組み合わせる。 */
export function focalFitCqi(text: string): string {
  return `${(100 / Math.max(estimateFocalEm(text), 1)).toFixed(2)}cqi`;
}
