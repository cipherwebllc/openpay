// AI エージェントが `Accept: text/markdown` でページを求めたかの判定 (2026-11-27)。
// Is Agentic (Vercel) と isitagentready (Cloudflare) の診断で、トップが Markdown を返さないことが
// 必須の 0 点だった。middleware から呼ぶので Node 専用の import を入れない (edge で動く)。
// ブラウザは text/markdown を送らないので、HTML の利用者の表示は変わらない。

/** Accept の q 値で text/markdown が text/html 以上に好まれていれば true。 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = 0;
  let html = 0;
  for (const range of accept.split(',')) {
    const [rawType, ...params] = range.split(';');
    const type = rawType.trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key?.trim().toLowerCase() !== 'q') continue;
      const n = Number(value?.trim());
      // 読めない q は 0 = その型を求めていないとみなす (HTML に倒す)。
      q = Number.isFinite(n) ? n : 0;
    }
    if (type === 'text/markdown') markdown = Math.max(markdown, q);
    else if (type === 'text/html') html = Math.max(html, q);
  }
  return markdown > 0 && markdown >= html;
}
