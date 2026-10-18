// ガイドの文の分け方。開示の文 (Landing.faqA2 など・掟 14 フェンス済み) を、文言を変えずに「要点」と「くわしく」に分ける
// ための純関数 (plans/guide-ux-polish-2.md P5)。文の区切りは括弧の外の「。」(日本語) か「. 」(英語) だけ
// (括弧の中の区切りで切ると、注記の途中で分かれてしまう)。

const OPEN = new Set(['（', '(', '〔', '[']);
const CLOSE = new Set(['）', ')', '〕', ']']);

/** 括弧の外の文の区切りで分ける。区切りの文字は前の文に残し、後ろの空白は落とす。分けた文をつなぐと元に戻る (空白を除く)。 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (OPEN.has(ch)) depth += 1;
    else if (CLOSE.has(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === '。' || (ch === '.' && text[i + 1] === ' '))) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/**
 * needle を含む最初の文の前で 2 つに分ける ([前, 後])。見つからなければ [全文, ''] (細部を隠さず全部を見せる)。
 * 前と後は、日本語は区切りなし・英語は空白 1 つでつなぐ。
 */
export function splitBeforeSentence(text: string, needle: string): [string, string] {
  const sentences = splitSentences(text);
  const at = sentences.findIndex((s) => s.includes(needle));
  if (at <= 0) return [text, ''];
  const join = (parts: string[]) => parts.join(/[。]$/.test(parts[0] ?? '') ? '' : ' ');
  return [join(sentences.slice(0, at)), join(sentences.slice(at))];
}

/**
 * 数字と和文の間の半角スペースを改行しない空白 (NBSP) にする。「8 / つのこと」「2 / 台持ち」「約 5 / 分」のように、数字と
 * 単位・助数詞が別の行に分かれるのを防ぐ (iOS Safari は word-break: auto-phrase に対応しないため、文字で止める・P7)。
 * 英語どうしの空白 (数字と英字) はそのまま。
 */
export function keepNumbersTogether(text: string): string {
  return text.replace(/(?<=\d) (?=[^\x00-\x7f])|(?<=[^\x00-\x7f]) (?=\d)/g, '\u00a0');
}
