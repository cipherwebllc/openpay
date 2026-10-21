// 文中の https URL をリンクにするための切り分け (/guide/sell の注意書き等)。
// URL は空白・かっこ・日本語の句読点の手前で終わり、末尾の英文の句読点は含めない — 文の途中の
// 「(https://…/arc-payout) で…」のような書き方で、後ろの文章までリンクに入れない (2026-10-21 本番で 404)。

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; href: string };

const URL_RE = /https:\/\/[^\s()（）「」『』、。，]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

export function splitTextLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const href = match[0].replace(TRAILING_PUNCT_RE, '');
    const start = match.index;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', href });
    last = start + href.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
