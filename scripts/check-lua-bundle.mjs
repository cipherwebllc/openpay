#!/usr/bin/env node
// next build 後に、サーバーバンドル内の Lua (Upstash EVAL 用 CAS スクリプト) がソースどおりに
// 残っているかを検査する。
//
// 動機 (2026-09-03〜06 実害): Next.js の minifier が `+` 連結の中のテンプレートリテラル
// (`...${REVERIFY_HIDE_THRESHOLD} then hidden=true end; ` + '...') の **`${}` 以降の末尾と後続の
// 文字列片を落とし**、本番だけ Lua が `failures>=3if ARGV[5]==...` に化けて EVAL が構文エラー (400)
// → 再検証 cron が 3 日間 503。vitest (ソース文字列) / dev / 本番 DB 直叩きは全部通るため、
// **ビルド成果物を見る以外に検出手段が無い**。
//
// 検査:
//   (1) 期待断片 (ソースの reverifyThresholds.ts から閾値を読んで組み立て) が .next/server 配下の
//       いずれかの chunk に **そのまま** 含まれること
//   (2) 壊れ方の典型 (`>=<数字>if ` のように文が連結される) が server 配下に無いこと
// 使い方: `npm run build` の後に `node scripts/check-lua-bundle.mjs` (CI の build ステップで実行)。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const thresholdsSrc = readFileSync(join(root, 'lib/x402/reverifyThresholds.ts'), 'utf8');
const hide = /REVERIFY_HIDE_THRESHOLD = (\d+)/.exec(thresholdsSrc)?.[1];
const authHide = /REVERIFY_AUTH_HIDE_THRESHOLD = (\d+)/.exec(thresholdsSrc)?.[1];
if (!hide || !authHide) {
  console.error('check-lua-bundle: reverifyThresholds.ts から閾値を読めませんでした');
  process.exit(2);
}

// ソース (lib/x402/reverify.ts) の REVERIFY_COUNTER_TRANSITION の「閾値の直後から次の閾値の直前まで」を
// 期待値にする。minifier が落とした断片 (テンプレートの末尾 + 後続 2 文) をちょうど跨ぐ。閾値そのものは
// バンドルで `"..."+String(3)+"..."` のまま残る (畳み込まれない) ことがあるので、閾値を含めずに前後の
// 定数片だけを検査し、閾値が `>=3 then` に畳み込まれた場合も `>="+String(3)+" then` の場合も通す。
const EXPECTED = [
  "if ARGV[4]=='violation' and failures>=",
  " then hidden=true end; if ARGV[5]=='clear' then authFailures=0; " +
    "elseif ARGV[5]=='block' then authFailures=authFailures+1; end; " +
    "if ARGV[5]=='block' and authFailures>=",
  ' then hidden=true end; local v={lastCheckedAt=ARGV[2],failures=failures,lastRunId=ARGV[3],probedUrl=ARGV[1]}; ',
  'return cjson.encode({failures=failures,authFailures=authFailures,before=before,after=hidden})',
];
// 閾値がソースと一致することは、畳み込まれた形か String(<n>) の形のどちらかで確認する。
const THRESHOLD_FORMS = [
  [`failures>=${hide} then`, `failures>="+String(${hide})+" then`],
  [`authFailures>=${authHide} then`, `authFailures>="+String(${authHide})+" then`],
];
// 文が連結された壊れ方 (数字の直後に空白なしで if/local/return が続く)。
const BROKEN = /(?:>=|==)\d+(?:if|local|return|elseif)\b/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const serverDir = join(root, '.next', 'server');
let files;
try {
  files = walk(serverDir, []);
} catch {
  console.error('check-lua-bundle: .next/server がありません (先に next build)');
  process.exit(2);
}

const found = EXPECTED.map(() => null);
const thresholdFound = THRESHOLD_FORMS.map(() => null);
const broken = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  EXPECTED.forEach((fragment, i) => {
    if (found[i] === null && src.includes(fragment)) found[i] = file;
  });
  THRESHOLD_FORMS.forEach((forms, i) => {
    if (thresholdFound[i] === null && forms.some((f) => src.includes(f))) thresholdFound[i] = file;
  });
  const m = BROKEN.exec(src);
  if (m) broken.push({ file, sample: src.slice(Math.max(0, m.index - 60), m.index + 40) });
}

let failed = false;
EXPECTED.forEach((fragment, i) => {
  if (found[i]) {
    console.log(`[OK] Lua 断片 ${i + 1} が ${found[i].replace(root + '/', '')} に無傷で存在`);
  } else {
    failed = true;
    console.error(`[NG] Lua 断片 ${i + 1} がサーバーバンドルに見つかりません (minifier が落とした疑い):`);
    console.error(`     ${fragment.slice(0, 120)}...`);
  }
});
THRESHOLD_FORMS.forEach((forms, i) => {
  if (thresholdFound[i]) {
    console.log(`[OK] 閾値 ${i + 1} (${forms[0]}) がバンドルに存在`);
  } else {
    failed = true;
    console.error(`[NG] 閾値 ${i + 1} がバンドルに見つかりません: ${forms.join(' / ')}`);
  }
});
for (const b of broken) {
  failed = true;
  console.error(`[NG] 文が連結された Lua を検出: ${b.file.replace(root + '/', '')}`);
  console.error(`     ...${b.sample}...`);
}
if (failed) {
  console.error('check-lua-bundle: FAIL — Lua 連結にテンプレートリテラルを使わない (lib/x402/reverify.ts 冒頭の注意)');
  process.exit(1);
}
console.log('check-lua-bundle: OK');
