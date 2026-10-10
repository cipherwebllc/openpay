#!/usr/bin/env node
// next build 後に、ブラウザへ配る JS (.next/static/**/*.js) にクラスの static 初期化ブロック (ES2022) が残っていないかを
// 検査する。残っていたら exit 1。
//
// 動機 (2026-10 本番 Sentry `SyntaxError: Unexpected token '{'`・/:locale/create): intl-messageformat (next-intl →
// use-intl 経由) の static ブロックが [locale] の layout の chunk にそのまま入り、static ブロックを読めないブラウザ
// (Safari / iOS 16.4 未満・Chrome 94 未満・Firefox 93 未満) では chunk の読み込みが SyntaxError で失敗して全ページの JS が
// 止まっていた。Next は node_modules の構文を既定のターゲットへ下げないので、依存の更新で再び入りうる。
// 直し方: 該当する依存を next.config.mjs の transpilePackages に足す (SWC が既定のターゲットまで下げる)。
// 走査の規則は scripts/lib/clientSyntax.mjs (字句走査)。走査が同期を失ったファイルも、static ブロックを見落とした
// 可能性があるので fail させる (fail-closed)。
// 使い方: `npm run build` の後に `node scripts/check-client-syntax.mjs` (CI の build ステップで実行)。

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanClientSource } from './lib/clientSyntax.mjs';

const root = process.cwd();
const staticDir = join(root, '.next', 'static');

let files;
try {
  files = readdirSync(staticDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => join(entry.parentPath, entry.name));
} catch {
  console.error('check-client-syntax: .next/static がありません (先に next build)');
  process.exit(2);
}
// 何も読まずに OK を出さない (build の出力先が変わった等)。
if (files.length === 0) {
  console.error('check-client-syntax: .next/static に .js がありません (先に next build)');
  process.exit(2);
}

let found = 0;
let unreadable = 0;
for (const file of files) {
  const { staticBlocks, error } = scanClientSource(readFileSync(file, 'utf8'));
  for (const hit of staticBlocks) {
    found++;
    console.error(`[NG] static ブロック: ${relative(root, file)}:${hit.line}:${hit.column}`);
    console.error(`     …${hit.sample}…`);
  }
  if (error) {
    unreadable++;
    console.error(`[NG] 字句走査が同期を失った (${error.message}): ${relative(root, file)}:${error.line}:${error.column}`);
    console.error(`     …${error.sample}…`);
  }
}
if (found > 0) {
  console.error(
    `check-client-syntax: FAIL — client chunk に static ブロックが ${found} 件 (Safari / iOS 16.4 未満等で SyntaxError)。` +
      '出どころの依存を next.config.mjs の transpilePackages に足す',
  );
}
if (unreadable > 0) {
  console.error(
    `check-client-syntax: FAIL — 字句走査が同期を失ったファイルが ${unreadable} 件 (static ブロックを見落としうる)。` +
      'scripts/lib/clientSyntax.mjs の読み分けを直す',
  );
}
if (found > 0 || unreadable > 0) process.exit(1);
console.log(`check-client-syntax: OK (${files.length} files, static ブロックなし)`);
