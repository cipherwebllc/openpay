// トップ (/・/ja・/en) を `Accept: text/markdown` で求められたときの Markdown 版 (2026-11-27)。
// middleware.ts がこの route へ内部で rewrite する (URL は / のまま)。中身は public/llms.txt と同じ
// = サイトの概要として既に公開・同期している文書 (掟 14 のフェンス対象) で、新しい文言は足さない。
// force-dynamic にする理由: static (prerender) にすると Vercel の build が Vary を RSC 用の値で
// 上書きし、Vary: Accept が消える (Is Agentic の必須の条件)。要求のたびに小さな function が動くが、
// Markdown を求めるのは AI エージェントだけ。llms.txt は next.config.mjs の
// outputFileTracingIncludes で function に同梱する。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const markdown = readFileSync(join(process.cwd(), 'public', 'llms.txt'));
  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      // 同じ URL が Accept で HTML と Markdown に分かれることを、間のキャッシュに伝える。
      Vary: 'Accept',
    },
  });
}
