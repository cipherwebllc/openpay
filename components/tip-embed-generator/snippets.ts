// 公開のカードに出す埋め込みコードと X シェアの URL (純関数)。tipUrl は親の TipEmbedGenerator が作り、
// 空 (未確定) のときは呼ばない。出力の文字列は tests/components/TipEmbedGenerator-pinning.test.tsx が固定している。

const IFRAME_WIDTH = 380;
const IFRAME_HEIGHT = 640;

export function iframeSnippetFor(tipUrl: string): string {
  return `<iframe
  src="${escapeAttr(tipUrl)}"
  width="${IFRAME_WIDTH}"
  height="${IFRAME_HEIGHT}"
  style="border:0;max-width:100%"
  title="OpenPay Tip"
  loading="lazy"
></iframe>`;
}

// SNS シェア: X (Twitter) の intent。text と url を別々に渡し、X 側で url を unfurl
// させる (P1 の動的 OG カードが表示される)。
export function xShareUrlFor(shareText: string, tipUrl: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    shareText,
  )}&url=${encodeURIComponent(tipUrl)}`;
}

// ボタン埋め込み: note / Linktree / ブログに貼れる「チップ」ボタン (styled <a>)。
// ラベル・URL とも HTML へ実体参照化して注入 (escapeAttr は & " < > を変換)。
export function buttonSnippetFor(tipUrl: string, buttonColor: string, buttonLabel: string): string {
  return `<a href="${escapeAttr(tipUrl)}" target="_blank" rel="noopener"
  style="display:inline-block;background:${buttonColor};color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">${escapeAttr(buttonLabel)}</a>`;
}

function escapeAttr(value: string): string {
  // iframe src 属性に埋め込むため、ダブルクォートと < > & を実体参照化。
  // URLSearchParams の出力は既に URL エンコード済みなので、追加の HTML エスケープのみ必要。
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
