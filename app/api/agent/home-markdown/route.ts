// トップ (/・/ja・/en) を `Accept: text/markdown` で求められたときの Markdown 版 (2026-11-27)。
// middleware.ts がこの route へ内部で rewrite する (URL は / のまま)。中身は public/llms.txt と同じ
// = サイトの概要として既に公開・同期している文書 (掟 14 のフェンス対象) で、新しい文言は足さない。
// force-static = build 時に 1 回だけ読み、以後は CDN から配る (実行時にファイルを読まない)。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-static';

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
