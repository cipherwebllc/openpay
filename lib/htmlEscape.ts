// 自前で組み立てる HTML の文字列 (サイトに貼る埋め込みのコード) に値を入れるときの実体参照化。
// & " < > を変えるので、" で囲んだ属性の値にも、要素の中の文字にも使える (' は変えない = 属性は必ず " で囲む)。
// URLSearchParams で作った URL も、引数の区切りの & は生のまま残るので、属性に入れる前にここを通す。
// 使う所: チップの埋め込みコード (components/tip-embed-generator/snippets.ts)・注文リンクのサイトのボタン
// (lib/orderLinkSiteButton.ts)。
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
