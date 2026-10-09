// 画面の文の中に「POL・KAIA・AVAX」のような並びを埋め込むときの区切り (locale ごと)。
// ja は中黒「・」で並べる (UI 全体の書き方に合わせる)。それ以外は Intl.ListFormat (en: "POL, KAIA, and AVAX")。
// 英語の文に「・」「〜」が混ざらないよう、並びと範囲の記号は呼び出し側で locale に従わせる。

export function formatLocaleList(locale: string, items: readonly string[]): string {
  if (locale === 'ja') return items.join('・');
  return new Intl.ListFormat(locale, { type: 'conjunction', style: 'long' }).format(items);
}
