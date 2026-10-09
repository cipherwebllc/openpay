// @vitest-environment node
// scripts/lib/luaSources.mjs (repo の Lua の列挙・テンプレート禁止・本番 bundle の破損検査・実 Lua テストの網) の検証。
// 第 7 回レビュー C5 / F10 / F17 / E11: どれも「どの文字列が Lua か」を手で列挙していたため、新しい Lua が網から漏れた。
import { describe, expect, it } from 'vitest';
import {
  checkLuaInBundle,
  evaluateLuaRealCoverage,
  extractLuaScripts,
  listLuaScripts,
  luaRealCoverage,
  resolveLuaSource,
} from '@/scripts/lib/luaSources.mjs';
import { LUA_REAL_TEST_FILES, LUA_WITHOUT_REAL_TEST } from '@/scripts/lib/luaRealTests.mjs';

const root = process.cwd();
const scripts = listLuaScripts(root);

describe('extractLuaScripts', () => {
  it('`+` 連結・join 配列・テンプレートを 1 本の Lua にまとめ、値の分からない部品を dynamic にする', () => {
    const found = extractLuaScripts('lib/sample.ts', [
      "const N = 3;",
      "const GUARD = \"local g=redis.call('GET',KEYS[2]); \";",
      "const A = \"local c=redis.call('GET',KEYS[1]); \" + 'if tonumber(c)>=' + String(N) + ' then return 0 end; ' + GUARD + 'return 1';",
      "const B = ['local x = 1', \"return redis.call('DEL', KEYS[1])\"].join('\\n');",
      'const C = `',
      "return redis.call('TTL', KEYS[1])",
      '`;',
      "export function wrap(s: string) { return 'local function t() ' + s + ' end; ' + GUARD; }",
      "const NOT_LUA = 'hello ' + String(N);",
    ].join('\n'));
    expect(found.map((script) => script.id)).toEqual([
      'lib/sample.ts#GUARD', 'lib/sample.ts#A', 'lib/sample.ts#B', 'lib/sample.ts#C', 'lib/sample.ts#wrap()',
    ]);
    const [, a, b, , wrap] = found;
    expect(a.dynamic).toEqual(['String(N)', 'GUARD']);
    expect(a.fragments).toEqual(["local c=redis.call('GET',KEYS[1]); ", 'if tonumber(c)>=', ' then return 0 end; ', 'return 1']);
    expect(b.parts).toEqual([{ text: 'local x = 1' }, { text: '\n' }, { text: "return redis.call('DEL', KEYS[1])" }]);
    // 目印 (redis.call 等) の無い片だけの組み立て式も、同じ file の Lua を部品にしていれば Lua とみなす。
    expect(wrap.parts).toEqual([{ text: 'local function t() ' }, { expr: 's' }, { text: ' end; ' }, { expr: 'GUARD' }]);
    expect(found.every((script) => script.templateSubstitutions.length === 0)).toBe(true);
  });

  it('E11: Lua の組み立て式の中の `${}` 付きテンプレートを templateSubstitutions に記録する', () => {
    const [script] = extractLuaScripts('lib/sample.ts',
      "const N = 3;\nconst BAD = \"local f=tonumber(ARGV[1]); \" + `if f>=${N} then return 1 end; ` + 'return 0';");
    expect(script.templateSubstitutions).toEqual(['N']);
    // Lua 定数を `${}` で差し込むだけのテンプレート (静的な片に目印が無い) も拾う。
    const composed = extractLuaScripts('lib/sample.ts',
      "const GUARD = \"local g=redis.call('GET',KEYS[1]); \";\nconst BAD = `${GUARD} return 1`;");
    expect(composed.map((entry) => [entry.name, entry.templateSubstitutions])).toEqual([['GUARD', []], ['BAD', ['GUARD']]]);
  });

  it('realRedis.call (lib/license/stock.ts) と .mjs の Lua も拾う', () => {
    expect(scripts.map((script) => script.id)).toEqual(expect.arrayContaining([
      'lib/license/stock.ts#PRELUDE',
      'lib/license/stock.ts#licenseLuaVariant()',
      'lib/x402/resourceUrlClaim.mjs#URL_CLAIM_GUARD',
      'lib/x402/facilitatorReservation.ts#CONSUME_RESERVATION',
      'app/api/order/notify/route.ts#RECONCILE_FEE',
      'scripts/kv-restore.mjs#INSTALL_LUA',
    ]));
    expect(scripts.length).toBeGreaterThanOrEqual(80);
  });
});

describe('repo の Lua のフェンス', () => {
  it('E11: 外部送信する Lua に `${}` 付きテンプレートを使わない (minifier が `${}` 以降を落とした 2026-09 の実害)', () => {
    expect(scripts.filter((script) => script.templateSubstitutions.length > 0).map((script) => script.id)).toEqual([]);
  });

  it('F10: 実 Lua テストの無い Lua の一覧 (LUA_WITHOUT_REAL_TEST) は実在する Lua だけ・重複なし', () => {
    const ids = new Set(scripts.map((script) => script.id));
    expect(LUA_WITHOUT_REAL_TEST.filter((id) => !ids.has(id))).toEqual([]);
    expect(new Set(LUA_WITHOUT_REAL_TEST).size).toBe(LUA_WITHOUT_REAL_TEST.length);
    expect(LUA_REAL_TEST_FILES).toContain('tests/scripts/lua-compile-lua.test.ts');
  });
});

describe('luaRealCoverage / evaluateLuaRealCoverage', () => {
  const sample = extractLuaScripts('lib/sample.ts', [
    "const GUARD = \"local g=redis.call('GET',KEYS[2]); \";",
    "const USES_GUARD = GUARD + \"return redis.call('DEL',KEYS[1])\";",
    "const STANDALONE = \"return redis.call('INCR',KEYS[1])\";",
    "const TINY = \"return redis.call('GET',KEYS[1])\";",
    "const WRAPPED = \"local v=redis.call('HGET',KEYS[1],ARGV[1]); \";",
    "export function wrap(s: string) { return 'local function t() ' + s + ' end; ' + GUARD + 'return t()'; }",
  ].join('\n'));
  const ids = (names: string[]) => names.map((name) => `lib/sample.ts#${name}`);

  it('単独の Lua は本文全体の一致、部品と関数で包んだ Lua は組み立てた本文の一部として数える', () => {
    const executed = [
      "local g=redis.call('GET',KEYS[2]); return redis.call('DEL',KEYS[1])",
      "local function t() local v=redis.call('HGET',KEYS[1],ARGV[1]);  end; local g=redis.call('GET',KEYS[2]); return t()",
      // TINY の本文を含むが TINY 単独の実行ではない (前後を固定しないと数えてしまう)。
      "local x=1; return redis.call('GET',KEYS[1])",
    ];
    expect(luaRealCoverage(sample, executed)).toEqual({
      covered: ids(['GUARD', 'USES_GUARD', 'WRAPPED', 'wrap()']),
      uncovered: ids(['STANDALONE', 'TINY']),
    });
  });

  it('allowlist に無い未実行の Lua は missing、allowlist にあるのに実行された・存在しない Lua は stale', () => {
    const executed = ["return redis.call('INCR',KEYS[1])"];
    expect(evaluateLuaRealCoverage({
      scripts: sample,
      executed,
      allowlist: ids(['GUARD', 'USES_GUARD', 'WRAPPED', 'wrap()', 'STANDALONE', 'GONE']),
    })).toEqual({ missing: ids(['TINY']), stale: ids(['STANDALONE', 'GONE']) });
  });
});

describe('checkLuaInBundle (F17: 本番 bundle の Lua の破損検査を全 Lua に)', () => {
  // next build に入るのは lib/ と app/ の Lua だけ (scripts/ は node で直接動く運用スクリプト)。
  const bundledScripts = scripts.filter((script) => !script.file.startsWith('scripts/'));
  // minifier の出力を真似る: 組み立て式は 1 本の二重引用符の文字列に畳まれ、改行は \n にエスケープされる。
  const bundled = (placeholder = '3') => bundledScripts
    .map((script) => `const ${script.name.replace(/\W/g, '_')}=${JSON.stringify(resolveLuaSource(script, scripts, placeholder))};`)
    .join('\n');

  it('repo の全 Lua が無傷で入った bundle は broken 0・absent 0', () => {
    const result = checkLuaInBundle(bundledScripts, [{ name: 'server/app/route.js', text: bundled() }]);
    expect(result.broken).toEqual([]);
    expect(result.absent).toEqual([]);
    expect(result.present.length).toBeGreaterThanOrEqual(60);
  });

  it('2026-09-06 型の破損 (`>=` + 閾値 + 後続の片が落ちて文が連結される) を broken として検出する', () => {
    const text = bundled().replace(/ then hidden=true end; if ARGV\[5\]==/g, 'if ARGV[5]==');
    const result = checkLuaInBundle(bundledScripts, [{ name: 'server/app/reverify.js', text }]);
    expect(result.broken.flatMap((entry) => entry.ids)).toContain('lib/x402/reverify.ts#REVERIFY_COUNTER_TRANSITION');
    expect(result.broken.every((entry) => entry.file === 'server/app/reverify.js')).toBe(true);
  });

  it('末尾の片が落ちた Lua も検出し、丸ごと無い Lua (flag OFF の tree-shake) は absent で fail にしない', () => {
    const cut = bundled().replace("redis.call('SET',KEYS[1],cjson.encode(record),'EX',ttl); return 1", '');
    expect(checkLuaInBundle(bundledScripts, [{ name: 'chunk.js', text: cut }]).broken.flatMap((entry) => entry.ids))
      .toEqual(['lib/x402/facilitatorReservation.ts#CONSUME_RESERVATION']);
    const reservation = scripts.filter((script) => script.id === 'lib/x402/facilitatorReservation.ts#CONSUME_RESERVATION');
    const result = checkLuaInBundle(reservation, [{ name: 'chunk.js', text: 'const unrelated = 1;' }]);
    expect(result).toMatchObject({ broken: [], absent: [['lib/x402/facilitatorReservation.ts#CONSUME_RESERVATION']] });
  });
});
