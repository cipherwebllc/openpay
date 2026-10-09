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
//   (3) lib/・app/ の送信式から送る **全 Lua** (scripts/lib/luaSources.mjs が送信式から構文木で辿る・
//       第 7 回レビュー F17 / E11) について、組み立てに使った式ごとに、ソースの文字列の連なりが chunk の文字列の値
//       (デコード後・短い定数や引用符も含めて) にそのまま残ること。一部だけ残る chunk = minifier が片を落とした・
//       書き換えた (broken)。送信式が bundle に在るのにどの chunk にも無い = missing。どちらも fail。
//       送信式ごと bundle に無い (tree-shake) ときだけ absent として一覧に出す。送信式が在る根拠を示せない Lua は
//       在るとみなす (fail-closed)。解析できない送信式・送信式から辿れない Lua らしい文字列も fail。
//       (1)(2) の手書きの断片は reverify の閾値の出力形も見るので残す。
// 使い方: `npm run build` の後に `node scripts/check-lua-bundle.mjs` (CI の build ステップで実行)。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeLua, bundleStrings, checkLuaInBundle } from './lib/luaSources.mjs';

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
  'if ARGV[5]==',
  'v.lease.token~=ARGV[1] then return -1 end;',
  'active~=ARGV[4] then return 0 end;',
  'stock.reserved+stock.sold>=stock.supply then return -4 end;',
  'stock.sold=stock.sold+1; quota=quota-1;',
  'reservation.state=',
  'for _,w in ipairs(writes) do realRedis.call(unpack(w)) end; return result;',

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
const BROKEN = /(?:(?:>=|==)\d+|stock\.supply|stock\.sold\+1)(?:if|local|return|elseif)\b/;

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
const bundleFiles = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  bundleFiles.push({ name: file.replace(root + '/', ''), text: src });
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

// (3) 送信式から送る全 Lua。next build に入るのは lib/・app/ の送信式 (scripts/ は node で直接動く)。
const analysis = analyzeLua(root);
for (const error of analysis.errors) {
  failed = true;
  console.error(`[NG] 解析できない送信式: ${error.file}:${error.line} (${error.reason}) ${error.expr ?? error.id ?? ''}`);
}
for (const orphan of analysis.orphans) {
  failed = true;
  console.error(`[NG] 送信式から辿れない Lua らしい文字列: ${orphan.file}:${orphan.line} ${orphan.text}`);
}
const lua = checkLuaInBundle(analysis, bundleFiles.map((file) => ({ name: file.name, strings: bundleStrings(file.text, file.name) })));
for (const entry of lua.broken) {
  failed = true;
  console.error(`[NG] Lua の片がバンドルで欠けている・書き換わっている (minifier の疑い): ${entry.id} @ ${entry.file}`);
  for (const run of entry.missing.slice(0, 3)) console.error(`     ソースの片: ${JSON.stringify(run.slice(0, 160))}`);
}
for (const id of lua.missing) {
  failed = true;
  console.error(`[NG] 送信式が bundle に在るのに Lua がどの chunk にも欠けずに残っていない: ${id}`);
}
if (lua.checked.length === 0) {
  // 0 本 = 解析か walk が壊れている。検査したことにして通さない。
  failed = true;
  console.error('[NG] lib/・app/ の Lua が 1 本もバンドルで確認できません (検査の前提が壊れている)');
}
console.log(`[INFO] lib/・app/ から送る Lua ${analysis.units.filter((unit) => unit.bundled).length} 本・組み立ての式: 無傷 ${lua.checked.length}・欠落 ${lua.missing.length}・破損 ${lua.broken.length}・送信式ごと無い ${lua.absent.length}`);
for (const id of lua.absent) console.log(`[INFO] 送信式ごと bundle に無い (tree-shake): ${id}`);
if (failed) {
  console.error('check-lua-bundle: FAIL — Lua 連結にテンプレートリテラルを使わない (lib/x402/reverify.ts 冒頭の注意)');
  process.exit(1);
}
console.log('check-lua-bundle: OK');
