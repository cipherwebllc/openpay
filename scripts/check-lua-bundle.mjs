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
import { checkComposition } from './lib/luaBundleComposition.mjs';

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

  // 最初の再検証を待つ新規掲載の印 (pendingFirstVerification・PR-09b)。落ちると、閾値で隠れた掲載が ID の照会で
  // 引けたまま台帳も書かれない / 台帳を継承した掲載が印を持ったままになる。
  // reverify.ts REVERIFY_PENDING_FIRST_VERIFICATION (条件と nil 代入。閾値は下の THRESHOLD_FORMS)
  "if (not hidden) or (ARGV[4]=='violation' and failures>=",
  ") or (ARGV[5]=='block' and authFailures>=",
  ') then o.pendingFirstVerification=nil end; ',
  // reverify.ts REVERIFY_HIDDEN_URL_LEDGER (印つきの hidden には台帳を書かない)
  "if hidden and o.pendingFirstVerification~=true then redis.call('SET',KEYS[2],ARGV[6],'EX',ARGV[7]) end; ",
  // registry.ts CAS_CREATE (台帳がある URL は hidden の doc = ARGV[4] で作る。印を付けないのは JS 側の
  // createResource が ARGV[4] を印なしで組むため = Lua の連結ではないので tests/lib/x402/registry-moderation-lua.test.ts が検査)
  "redis.call('EXISTS',KEYS[6])==1 then doc=ARGV[4]; code=3 end; redis.call('SET',KEYS[1],doc); ",
  // registry.ts CAS_UPDATE (台帳済 URL への PATCH で印を外す)
  "redis.call('EXISTS',KEYS[5])==1 then o.hidden=true; o.pendingFirstVerification=nil end; end; o.url=ARGV[2]; ",
  // registry.ts CAS_DEACTIVATE_WITH_LEDGER (印つきの削除は台帳を書かない)
  "if o.url~=ARGV[5] then return -4 end; if o.hidden==true and o.pendingFirstVerification~=true then " +
    "redis.call('SET',KEYS[3],ARGV[3],'EX',ARGV[4]) end; ",
];
// 閾値がソースと一致することは、畳み込まれた形か String(<n>) の形のどちらかで確認する。
const THRESHOLD_FORMS = [
  [`failures>=${hide} then`, `failures>="+String(${hide})+" then`],
  [`authFailures>=${authHide} then`, `authFailures>="+String(${authHide})+" then`],
  // REVERIFY_PENDING_FIRST_VERIFICATION の 2 つの閾値 (カウンタ遷移の `>=n then` とは後ろの形で区別する)。
  // ⚠️ ここに Lua の印 (ARGV[ / KEYS[ / redis.call) を入れない: テンプレートの中にあると
  // tests/lib/luaTemplateFence.test.ts がこの配列を Lua の定義とみなして違反にする。
  [`failures>=${hide}) or (`, `failures>="+String(${hide})+") or (`],
  [
    `authFailures>=${authHide}) then o.pendingFirstVerification=nil`,
    `authFailures>="+String(${authHide})+") then o.pendingFirstVerification=nil`,
  ],
];
// 断片が残っているだけでなく、CAS の決まった位置に連結されていることの検査。minifier は単発の定数を
// その場に畳み込むか、変数のまま `"+X+"` で連結するので、`+` の連結を AST でたどり、変数は使われた場所から
// 見えている宣言の値を求めて、断片の全体と一致するかを見る (scripts/lib/luaBundleComposition.mjs・限界もそこ)。
// expected は Lua の断片の全体 (閾値はソースの reverifyThresholds.ts から)。
const COMPOSED = [
  {
    // reverify.ts CAS_EXTERNAL_REVERIFY: 印の解除は restore の判定の直後・保存の前。
    name: '再検証の CAS が restore の判定の後で印を外す',
    after: "if checked and claim==-5 then restoreBlocked='url_taken' end; end; end; ",
    expected:
      "if (not hidden) or (ARGV[4]=='violation' and failures>=" + hide +
      ") or (ARGV[5]=='block' and authFailures>=" + authHide +
      ') then o.pendingFirstVerification=nil end; ',
  },
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
// 連結はバンドル全体で数える: `after` の出現が 1 つ以上あり、どのファイルのどの出現にも断片が続くこと。
const composedStats = COMPOSED.map(() => ({ total: 0, okFiles: [], failingFiles: [] }));
const broken = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  EXPECTED.forEach((fragment, i) => {
    if (found[i] === null && src.includes(fragment)) found[i] = file;
  });
  THRESHOLD_FORMS.forEach((forms, i) => {
    if (thresholdFound[i] === null && forms.some((f) => src.includes(f))) thresholdFound[i] = file;
  });
  COMPOSED.forEach(({ after, expected }, i) => {
    const { total, failing } = checkComposition(src, after, expected, file);
    if (total === 0) return;
    composedStats[i].total += total;
    (failing > 0 ? composedStats[i].failingFiles : composedStats[i].okFiles).push(file.replace(root + '/', ''));
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
COMPOSED.forEach(({ name }, i) => {
  const { total, okFiles, failingFiles } = composedStats[i];
  if (total > 0 && failingFiles.length === 0) {
    console.log(`[OK] 連結 ${i + 1} (${name}) が ${total} か所すべてで続く: ${okFiles.join(', ')}`);
  } else if (total === 0) {
    failed = true;
    console.error(`[NG] 連結 ${i + 1} (${name}) の直前の断片がバンドルに見つかりません`);
  } else {
    failed = true;
    console.error(`[NG] 連結 ${i + 1} (${name}) が続かない箇所があります (断片が落ちたか、変数の値が違う): ${failingFiles.join(', ')}`);
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
