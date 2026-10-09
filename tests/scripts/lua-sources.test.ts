// @vitest-environment node
// scripts/lib/luaSources.mjs (送信式から辿る Lua の列挙・テンプレート禁止・実 Lua テストの網・本番 bundle の検査) の検証。
// 第 7 回レビュー C5 / F10 / F17 / E11 と、その PR への Codex レビュー (P2×5・P3×1) の反例をそのまま固定する。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeLua,
  bundleStrings,
  checkLuaAllowlist,
  checkLuaInBundle,
  evaluateLuaRealCoverage,
  luaRealCoverage,
  unitSource,
  type LuaAnalysis,
} from '@/scripts/lib/luaSources.mjs';
import { LUA_WITHOUT_REAL_TEST } from '@/scripts/lib/luaRealTests.mjs';

const fixtures: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lua-sources-'));
  fixtures.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterAll(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

const KV = {
  'lib/kv.ts': [
    'function call(command: unknown[]) { return command; }',
    'export function kvEval(script: string, keys: string[], args: string[]) {',
    "  return call(['EVAL', script, String(keys.length), ...keys, ...args]);",
    '}',
  ].join('\n'),
};
const byId = (analysis: LuaAnalysis) => new Map(analysis.units.map((unit) => [unit.id, unit]));

const repo = analyzeLua(process.cwd());

describe('analyzeLua: 送信式から辿る (Codex P2-1)', () => {
  it('import した定数を `${}` で包む・目印を分けた連結・目印の無い文字列も、送信式から辿って本文に展開する', () => {
    const analysis = analyzeLua(fixture({
      ...KV,
      'lib/guard.ts': "export const GUARD = \"local g=redis.call('GET',KEYS[1]); \";",
      'lib/send.ts': [
        "import { kvEval } from './kv';",
        "import { GUARD } from '@/lib/guard';",
        'export const WRAPPED = `${GUARD} return 1`;',
        'export function a() { return kvEval(WRAPPED, [], []); }',
        "export function b() { return kvEval('redis.' + 'call(\"GET\", KEYS[1])', [], []); }",
        "export function c() { return kvEval('return 1', [], []); }",
      ].join('\n'),
    }));
    expect(analysis.errors).toEqual([]);
    expect(analysis.orphans).toEqual([]);
    const units = byId(analysis);
    expect([...units.keys()].sort()).toEqual(['lib/send.ts#WRAPPED', 'lib/send.ts#b()', 'lib/send.ts#c()']);
    expect(unitSource(units.get('lib/send.ts#WRAPPED')!)).toBe("local g=redis.call('GET',KEYS[1]);  return 1");
    // E11: 送る Lua の組み立てに `${}` 付きテンプレートがある。
    expect(units.get('lib/send.ts#WRAPPED')!.templates).toEqual(['GUARD']);
    expect(unitSource(units.get('lib/send.ts#b()')!)).toBe('redis.call("GET", KEYS[1])');
    expect(unitSource(units.get('lib/send.ts#c()')!)).toBe('return 1');
  });

  it('packages/ の送信式・転送関数 (script を引数で受けて送る関数) の呼び出しも送信式として辿る', () => {
    const analysis = analyzeLua(fixture({
      'packages/sdk/src/send.mjs': [
        'export function evalScript(redis, script) { return redis.eval(script, [], []); }',
        "export function run(redis) { return evalScript(redis, 'return redis.call(\"TIME\")'); }",
      ].join('\n'),
    }));
    expect(analysis.errors).toEqual([]);
    expect(analysis.units.map((unit) => [unit.id, unitSource(unit), unit.bundled]))
      .toEqual([['packages/sdk/src/send.mjs#run()', 'return redis.call("TIME")', false]]);
  });

  it('解析できない送信式は errors・送信式から辿れない Lua らしい文字列は orphans (検査をすり抜けさせない)', () => {
    const analysis = analyzeLua(fixture({
      ...KV,
      'lib/send.ts': [
        "import { kvEval } from './kv';",
        "const DEAD = \"return redis.call('GET', KEYS[1])\";",
        'export function a() { return kvEval(process.env.LUA_SCRIPT ?? "", [], []); }',
      ].join('\n'),
    }));
    expect(analysis.errors).toEqual([expect.objectContaining({ file: 'lib/send.ts', line: 3, reason: 'unresolved_script' })]);
    expect(analysis.orphans).toEqual([expect.objectContaining({ file: 'lib/send.ts', line: 2 })]);
  });

  it('repo: 解析できない送信式・送信式から辿れない Lua は 0。packages/ には送信式も Lua も無い', () => {
    expect(repo.errors).toEqual([]);
    expect(repo.orphans).toEqual([]);
    expect(repo.sites.filter((site) => site.file.startsWith('packages/'))).toEqual([]);
    expect(repo.exprs.filter((expr) => expr.file.startsWith('packages/'))).toEqual([]);
    expect(repo.units.map((unit) => unit.id)).toEqual(expect.arrayContaining([
      'lib/x402/facilitatorReservation.ts#CONSUME_RESERVATION',
      'lib/license/stock.ts#licenseLuaVariant(CAS)',
      'lib/x402/purchase/lua.ts#QUARANTINE_PENDING_MEMBER',
      'app/api/order/notify/route.ts#RECONCILE_FEE',
      'scripts/kv-restore.mjs#INSTALL_LUA',
    ]));
  });

  it('E11: 外部送信する Lua の組み立てに `${}` 付きテンプレートを使わない (minifier が `${}` 以降を落とした 2026-09 の実害)', () => {
    expect(repo.units.filter((unit) => unit.templates.length > 0).map((unit) => unit.id)).toEqual([]);
  });
});

describe('luaRealCoverage: 部品を展開した本文で照合する (Codex P2-2)', () => {
  const analysis = analyzeLua(fixture({
    ...KV,
    'lib/stock.ts': [
      "export const PRELUDE = \"local writes={}; \";",
      "export const COMMIT = \"for _,w in ipairs(writes) do redis.call(unpack(w)) end; return result\";",
      "export function wrap(script: string) { return PRELUDE + 'local function t() ' + script + ' end; local result=t(); ' + COMMIT; }",
    ].join('\n'),
    'lib/send.ts': [
      "import { kvEval } from './kv';",
      "import { wrap } from './stock';",
      "const CAS = \"return redis.call('SET',KEYS[1],ARGV[1])\";",
      "const GUARD_A = \"if redis.call('EXISTS',KEYS[2])==1 then return 0 end; \";",
      "const GUARD_B = \"if redis.call('EXISTS',KEYS[3])==1 then return 0 end; \";",
      "const UPDATE = GUARD_A + \"redis.call('SET',KEYS[1],ARGV[2]); \" + GUARD_B + 'return 1';",
      'export function a(license: boolean) { return kvEval(license ? wrap(CAS) : CAS, [], []); }',
      'export function b() { return kvEval(UPDATE, [], []); }',
    ].join('\n'),
  }));
  const source = (id: string) => {
    const unit = byId(analysis).get(id);
    expect(unit, id).toBeDefined();
    return unitSource(unit!);
  };

  it('包む関数の PRELUDE / COMMIT・両 guard を欠いた本文では、包んだ Lua も guard 付きの Lua も実行済みにしない', () => {
    const cas = "return redis.call('SET',KEYS[1],ARGV[1])";
    expect(luaRealCoverage(analysis.units, [
      cas,
      `local writes={}; local function t() ${cas} end; local result=t(); `,
      "redis.call('SET',KEYS[1],ARGV[2]); return 1",
    ])).toEqual({ covered: ['lib/send.ts#CAS'], uncovered: ['lib/stock.ts#wrap(CAS)', 'lib/send.ts#UPDATE'] });
  });

  it('部品まで展開した本文どおりに実行されたときだけ数える', () => {
    const wrapped = source('lib/stock.ts#wrap(CAS)');
    expect(wrapped).toBe("local writes={}; local function t() return redis.call('SET',KEYS[1],ARGV[1]) end; " +
      'local result=t(); for _,w in ipairs(writes) do redis.call(unpack(w)) end; return result');
    expect(luaRealCoverage(analysis.units, [wrapped, source('lib/send.ts#UPDATE')]).uncovered).toEqual(['lib/send.ts#CAS']);
  });

  it('allowlist に無い未実行の Lua は missing、allowlist にあるのに実行された・存在しない Lua は stale', () => {
    expect(evaluateLuaRealCoverage({
      units: analysis.units,
      executed: [source('lib/send.ts#UPDATE')],
      allowlist: ['lib/stock.ts#wrap(CAS)', 'lib/send.ts#UPDATE', 'lib/gone.ts#GONE'],
    })).toEqual({ missing: ['lib/send.ts#CAS'], stale: ['lib/send.ts#UPDATE', 'lib/gone.ts#GONE'] });
  });
});

describe('LUA_WITHOUT_REAL_TEST の形 (Codex P3)', () => {
  it('重複は止め、もう無い Lua は runner と同じく warning (一覧にある Lua を消す PR を止めない)', () => {
    const ids = repo.units.map((unit) => unit.id);
    const withGone = checkLuaAllowlist([...LUA_WITHOUT_REAL_TEST, 'lib/removed.ts#GONE'], ids);
    expect(withGone).toEqual({ blocking: [], gone: ['lib/removed.ts#GONE'] });
    expect(checkLuaAllowlist(['a#X', 'a#X'], ['a#X'])).toEqual({ blocking: ['a#X'], gone: [] });

    const current = checkLuaAllowlist(LUA_WITHOUT_REAL_TEST, ids);
    expect(current.blocking).toEqual([]);
    for (const id of current.gone) {
      console.warn(`::warning::${id} はもう送られていないので scripts/lib/luaRealTests.mjs の LUA_WITHOUT_REAL_TEST から消す`);
    }
  });
});

describe('bundleStrings', () => {
  it('引用符の種類・エスケープに左右されずに文字列の値を返す (正規表現の中の引用符で崩れない)', () => {
    expect(bundleStrings('let a="x\\"y",b=\'z\\n\',c=`t`;var r=/["\']/g;let d="ok";'))
      .toEqual(['x"y', 'z\n', 't', 'ok']);
  });
});

describe('checkLuaInBundle (F17・Codex P2-3 / P2-4 / P2-5)', () => {
  // minifier の出力を真似る: 組み立てた式の文字列の連なりが chunk の文字列としてそのまま残っている bundle。
  const bundled = repo.units.filter((unit) => unit.bundled);
  const exprIds = new Set(bundled.flatMap((unit) => unit.exprs));
  const runs = repo.exprs.filter((expr) => exprIds.has(expr.id)).flatMap((expr) => expr.runs);
  const consume = repo.exprs.find((expr) => expr.id === 'lib/x402/facilitatorReservation.ts#CONSUME_RESERVATION')!;
  const quarantine = repo.exprs.find((expr) => expr.id === 'lib/x402/purchase/lua.ts#QUARANTINE_PENDING_MEMBER')!;
  const chunk = (strings: string[]) => [{ name: 'server/chunks/1.js', strings }];

  it('repo の全 Lua が欠けずに入った bundle は broken・missing 0', () => {
    const result = checkLuaInBundle(repo, chunk(runs));
    expect(result).toMatchObject({ broken: [], missing: [], absent: [] });
    expect(result.checked.length).toBeGreaterThanOrEqual(80);
  });

  it('P2-3: CONSUME_RESERVATION の短い定数 "consumed" を "reserved" に書き換えた chunk を検出する', () => {
    expect(consume.runs.join('')).toContain('record.state=="consumed"');
    const tampered = runs.map((run) => (run === consume.runs[0] ? run.replace('"consumed" then return 2', '"reserved" then return 2') : run));
    const result = checkLuaInBundle(repo, chunk(tampered));
    expect(result.broken.map((entry) => entry.id)).toEqual([consume.id]);
    expect(result.missing).toEqual([consume.id]);
  });

  it('P2-4: 単独で送る purchase/lua.ts#QUARANTINE_PENDING_MEMBER の redis.call を壊すと検出する (同じ本文の別定数があっても省略しない)', () => {
    const tampered = runs.map((run) => (run === quarantine.runs[0] ? run.replace("redis.call('ZADD'", "redis.cal('ZADD'") : run));
    expect(tampered).not.toEqual(runs);
    expect(checkLuaInBundle(repo, chunk(tampered)).missing).toEqual([quarantine.id]);
  });

  it('P2-5: 呼び出しを残して CONSUME_RESERVATION の本文だけを消すと missing (送信式が在る根拠を示せない Lua は在るとみなす)', () => {
    const site = repo.units.find((unit) => unit.id === consume.id)!.sites;
    expect(site.every((entry) => entry.evidence.length === 0)).toBe(true);
    expect(checkLuaInBundle(repo, chunk(runs.filter((run) => !consume.runs.includes(run)))).missing).toEqual([consume.id]);
  });

  it('送信式ごと bundle に無い (後ろの文の固有の文字列も無い) Lua だけを absent にする', () => {
    const analysis = analyzeLua(fixture({
      ...KV,
      'lib/logger.ts': 'export const logger = { warn: (event: string) => event };',
      'lib/send.ts': [
        "import { kvEval } from './kv';",
        "import { logger } from './logger';",
        "const RELEASE = \"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0\";",
        'export async function release() {',
        "  const result = kvEval(RELEASE, ['lock'], ['owner']);",
        "  logger.warn('fixture.lock_release_event');",
        '  return result;',
        '}',
      ].join('\n'),
    }));
    const release = analysis.exprs.find((expr) => expr.id === 'lib/send.ts#RELEASE')!;
    expect(analysis.units[0].sites[0].evidence).toEqual(['fixture.lock_release_event']);
    expect(checkLuaInBundle(analysis, chunk(['unrelated']))).toMatchObject({ missing: [], absent: [release.id] });
    expect(checkLuaInBundle(analysis, chunk(['fixture.lock_release_event']))).toMatchObject({ missing: [release.id], absent: [] });
    expect(checkLuaInBundle(analysis, chunk(['fixture.lock_release_event', ...release.runs])))
      .toMatchObject({ checked: [release.id], missing: [], broken: [] });
  });
});
