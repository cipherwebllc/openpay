// @vitest-environment node
// repo の全 Lua (scripts/lib/luaSources.mjs が列挙する外部送信用の Lua) を本物の Lua の構文で読む (第 7 回レビュー C5)。
// 実 Lua テストがまだ無い Lua (scripts/lib/luaRealTests.mjs の LUA_WITHOUT_REAL_TEST) も、構文の誤りだけは
// 本番の EVAL より前に CI で止める。組み立て式の部品は同じ一覧の Lua で埋め、値の分からない部品は placeholder で埋める。
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedisLuaEngine, compileRedisLua } from '@/tests/_helpers/redisLua';
import { listLuaScripts, resolveLuaSource } from '../../scripts/lib/luaSources.mjs';

const scripts = listLuaScripts(process.cwd());
afterAll(closeRedisLuaEngine);

describe('外部送信する Lua はすべて Lua として読める', () => {
  it('Lua を列挙できている (急に減ったら抽出が壊れている)', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(80);
  });

  it.each(scripts.map((script) => [script.id, script] as const))('%s', async (_id, script) => {
    const errors: string[] = [];
    // 値の分からない部品は、式・文字列の中なら '0'、文の位置 (licenseLuaVariant の引数) なら '' で通る。
    for (const placeholder of ['0', '']) {
      const error = await compileRedisLua(resolveLuaSource(script, scripts, placeholder));
      if (error === null) return;
      errors.push(error);
    }
    expect.fail(errors.join(' / '));
  });

  it('構文の誤りは検出できる (検査そのものの確認)', async () => {
    expect(await compileRedisLua("local x = redis.call('GET', KEYS[1]) if x then return 1")).toMatch(/expected/);
    expect(await compileRedisLua("local x = redis.call('GET', KEYS[1]); if x then return 1 end; return 0")).toBeNull();
  });
});
