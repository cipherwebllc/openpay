// @vitest-environment node
// repo の送信式から送る全 Lua (scripts/lib/luaSources.mjs が送信式から辿って部品まで展開した本文) を本物の Lua の
// 構文で読む (第 7 回レビュー C5)。実 Lua テストがまだ無い Lua (scripts/lib/luaRealTests.mjs の LUA_WITHOUT_REAL_TEST) も、
// 構文の誤りだけは本番の EVAL より前に CI で止める。値の分からない部品は placeholder で埋める。
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedisLuaEngine, compileRedisLua } from '@/tests/_helpers/redisLua';
import { analyzeLua, unitSource } from '../../scripts/lib/luaSources.mjs';

const { units } = analyzeLua(process.cwd());
afterAll(closeRedisLuaEngine);

describe('外部送信する Lua はすべて Lua として読める', () => {
  it('送る Lua を列挙できている (急に減ったら解析が壊れている)', () => {
    expect(units.length).toBeGreaterThanOrEqual(75);
  });

  it.each(units.map((unit) => [unit.id, unit] as const))('%s', async (_id, unit) => {
    const errors: string[] = [];
    // 値の分からない部品は、式・文字列の中なら '0'、文の位置なら '' で通る。
    for (const placeholder of ['0', '']) {
      const error = await compileRedisLua(unitSource(unit, placeholder));
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
