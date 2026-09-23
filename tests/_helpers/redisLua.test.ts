// @vitest-environment node
// ハーネス自身のテスト。redisLua.ts は「Redis コマンドの意味論の再実装」なので、
// これが正しくないと本物の Lua を走らせても嘘の結果を検証してしまう。
// ⚠️ node 環境が必須 — wasmoon の emscripten glue は jsdom 下では document.baseURI から
// scriptDirectory を組み立てて createRequire に渡すため WASM の初期化に失敗する。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LuaFactory, type LuaEngine } from 'wasmoon';

import {
  closeRedisLuaEngine,
  createFakeRedisStore,
  dispatchRedisCommand,
  runRedisLua,
  type FakeRedisStore,
} from './redisLua';

let store: FakeRedisStore;

beforeEach(() => {
  store = createFakeRedisStore(1_000_000);
});

afterAll(async () => {
  await closeRedisLuaEngine();
});

function call(command: string, ...args: unknown[]) {
  return dispatchRedisCommand(store, command, args);
}

describe('fake store: 文字列コマンド', () => {
  it('GET は未存在で false (Redis の nil → Lua false)', () => {
    expect(call('GET', 'k')).toBe(false);
    call('SET', 'k', 'v');
    expect(call('GET', 'k')).toBe('v');
  });

  it('SET は status reply {ok=OK} を返す', () => {
    expect(call('SET', 'k', 'v')).toEqual({ ok: 'OK' });
  });

  it('SET NX は既存キーで false・未存在なら OK', () => {
    expect(call('SET', 'k', 'a', 'NX')).toEqual({ ok: 'OK' });
    expect(call('SET', 'k', 'b', 'NX')).toBe(false);
    expect(call('GET', 'k')).toBe('a');
  });

  it('SET XX は未存在で false', () => {
    expect(call('SET', 'k', 'a', 'XX')).toBe(false);
    expect(call('GET', 'k')).toBe(false);
    call('SET', 'k', 'a');
    expect(call('SET', 'k', 'b', 'XX')).toEqual({ ok: 'OK' });
    expect(call('GET', 'k')).toBe('b');
  });

  it('SET ... GET は旧値を返す (未存在は false)', () => {
    expect(call('SET', 'k', 'a', 'GET')).toBe(false);
    expect(call('SET', 'k', 'b', 'GET')).toBe('a');
    // NX 不成立でも GET があれば旧値を返し、値は変えない。
    expect(call('SET', 'k', 'c', 'NX', 'GET')).toBe('b');
    expect(call('GET', 'k')).toBe('b');
  });

  it('SET EX / PX は TTL を張り、素の SET は TTL を落とす', () => {
    call('SET', 'k', 'v', 'EX', '60');
    expect(store.getTtl('k')).toBe(60);
    call('SET', 'k', 'v2', 'PX', '5000');
    expect(store.getTtl('k')).toBe(5);
    call('SET', 'k', 'v3');
    expect(store.getTtl('k')).toBe(-1);
  });

  it('SET KEEPTTL は TTL を保つ', () => {
    call('SET', 'k', 'v', 'EX', '60');
    call('SET', 'k', 'v2', 'KEEPTTL');
    expect(store.getTtl('k')).toBe(60);
  });

  it('INCR は 0 起点で加算し、非整数値では例外', () => {
    expect(call('INCR', 'c')).toBe(1);
    expect(call('INCR', 'c')).toBe(2);
    call('SET', 'bad', 'x');
    expect(() => call('INCR', 'bad')).toThrow(/not an integer/);
  });

  it('DEL / EXISTS は可変長で件数を返す', () => {
    call('SET', 'a', '1');
    call('LPUSH', 'b', 'x');
    expect(call('EXISTS', 'a', 'b', 'c')).toBe(2);
    expect(call('DEL', 'a', 'b', 'c')).toBe(2);
    expect(call('EXISTS', 'a', 'b')).toBe(0);
  });

  it('TYPE は status reply で型名を返す', () => {
    expect(call('TYPE', 'none')).toEqual({ ok: 'none' });
    call('SET', 's', 'v');
    call('LPUSH', 'l', 'v');
    call('ZADD', 'z', '1', 'm');
    store.sets.set('t', new Set(['m']));
    expect(call('TYPE', 's')).toEqual({ ok: 'string' });
    expect(call('TYPE', 'l')).toEqual({ ok: 'list' });
    expect(call('TYPE', 'z')).toEqual({ ok: 'zset' });
    expect(call('TYPE', 't')).toEqual({ ok: 'set' });
  });
});

describe('fake store: TTL と仮想時計', () => {
  it('TTL は未存在 -2 / TTL 無し -1 / 残秒', () => {
    expect(call('TTL', 'k')).toBe(-2);
    call('SET', 'k', 'v');
    expect(call('TTL', 'k')).toBe(-1);
    call('EXPIRE', 'k', '30');
    expect(call('TTL', 'k')).toBe(30);
  });

  it('EXPIRE は未存在キーで 0', () => {
    expect(call('EXPIRE', 'nope', '10')).toBe(0);
    call('SET', 'k', 'v');
    expect(call('EXPIRE', 'k', '10')).toBe(1);
  });

  it('仮想時計を進めるとキーが失効する', () => {
    call('SET', 'k', 'v', 'EX', '10');
    store.advance(9_000);
    expect(call('GET', 'k')).toBe('v');
    store.advance(1_001);
    expect(call('GET', 'k')).toBe(false);
    expect(call('TTL', 'k')).toBe(-2);
  });

  it('PERSIST は TTL を外す', () => {
    call('SET', 'k', 'v', 'EX', '10');
    expect(call('PERSIST', 'k')).toBe(1);
    expect(call('TTL', 'k')).toBe(-1);
    expect(call('PERSIST', 'k')).toBe(0);
  });

  it('setTtl / getTtl / setNow がテストから使える', () => {
    call('SET', 'k', 'v');
    store.setTtl('k', 120);
    expect(store.getTtl('k')).toBe(120);
    store.setNow(store.now() + 60_000);
    expect(store.getTtl('k')).toBe(60);
    expect(store.keys()).toEqual(['k']);
  });
});

describe('fake store: リストコマンド', () => {
  it('LPUSH は head へ積み、LLEN が長さを返す', () => {
    expect(call('LPUSH', 'l', 'a')).toBe(1);
    expect(call('LPUSH', 'l', 'b', 'c')).toBe(3);
    expect(store.lists.get('l')).toEqual(['c', 'b', 'a']);
    expect(call('LLEN', 'l')).toBe(3);
    expect(call('LLEN', 'missing')).toBe(0);
  });

  it('LREM count=0 は全出現を消す', () => {
    call('LPUSH', 'l', 'a', 'b', 'a');
    expect(call('LREM', 'l', '0', 'a')).toBe(2);
    expect(store.lists.get('l')).toEqual(['b']);
  });

  it('LREM count>0 は head 側から / count<0 は tail 側から', () => {
    call('LPUSH', 'l', 'x', 'a', 'x', 'a', 'x');
    expect(store.lists.get('l')).toEqual(['x', 'a', 'x', 'a', 'x']);
    expect(call('LREM', 'l', '1', 'x')).toBe(1);
    expect(store.lists.get('l')).toEqual(['a', 'x', 'a', 'x']);
    expect(call('LREM', 'l', '-1', 'x')).toBe(1);
    expect(store.lists.get('l')).toEqual(['a', 'x', 'a']);
  });

  it('LTRIM は範囲外を捨て、空になればキーごと消える', () => {
    call('LPUSH', 'l', 'a', 'b', 'c', 'd');
    expect(call('LTRIM', 'l', '0', '1')).toEqual({ ok: 'OK' });
    expect(store.lists.get('l')).toEqual(['d', 'c']);
    call('LTRIM', 'l', '5', '9');
    expect(store.lists.has('l')).toBe(false);
  });

  it('LTRIM は負 index を末尾からとして解釈する', () => {
    call('LPUSH', 'l', 'a', 'b', 'c');
    call('LTRIM', 'l', '0', '-2');
    expect(store.lists.get('l')).toEqual(['c', 'b']);
  });
});

describe('fake store: sorted set コマンド', () => {
  beforeEach(() => {
    call('ZADD', 'z', '10', 'a');
    call('ZADD', 'z', '30', 'c');
    call('ZADD', 'z', '20', 'b');
  });

  it('ZADD は新規追加数を返し、既存 member は更新のみ', () => {
    expect(call('ZADD', 'z', '99', 'a')).toBe(0);
    expect(call('ZSCORE', 'z', 'a')).toBe('99');
    expect(call('ZADD', 'z', '1', 'd')).toBe(1);
  });

  it('ZSCORE は文字列 / 未存在は false', () => {
    expect(call('ZSCORE', 'z', 'b')).toBe('20');
    expect(call('ZSCORE', 'z', 'zzz')).toBe(false);
    expect(call('ZSCORE', 'missing', 'b')).toBe(false);
  });

  it('ZREM は削除数を返し、空になればキーが消える', () => {
    expect(call('ZREM', 'z', 'a', 'nope')).toBe(1);
    expect(call('ZREM', 'z', 'b', 'c')).toBe(2);
    expect(store.zsets.has('z')).toBe(false);
  });

  it('ZREVRANK は降順の 0 起点順位 / 未存在は false', () => {
    expect(call('ZREVRANK', 'z', 'c')).toBe(0);
    expect(call('ZREVRANK', 'z', 'a')).toBe(2);
    expect(call('ZREVRANK', 'z', 'zzz')).toBe(false);
  });

  it('ZREVRANGE は降順スライス・WITHSCORES で交互配列', () => {
    expect(call('ZREVRANGE', 'z', '0', '-1')).toEqual(['c', 'b', 'a']);
    expect(call('ZREVRANGE', 'z', '0', '1')).toEqual(['c', 'b']);
    expect(call('ZREVRANGE', 'z', '0', '1', 'WITHSCORES')).toEqual(['c', '30', 'b', '20']);
  });

  it('ZRANGEBYSCORE は境界・排他・LIMIT を解釈する', () => {
    expect(call('ZRANGEBYSCORE', 'z', '-inf', '+inf')).toEqual(['a', 'b', 'c']);
    expect(call('ZRANGEBYSCORE', 'z', '20', '30')).toEqual(['b', 'c']);
    expect(call('ZRANGEBYSCORE', 'z', '(20', '30')).toEqual(['c']);
    expect(call('ZRANGEBYSCORE', 'z', '-inf', '+inf', 'LIMIT', '1', '1')).toEqual(['b']);
    expect(call('ZRANGEBYSCORE', 'z', '-inf', '+inf', 'WITHSCORES', 'LIMIT', '0', '1')).toEqual([
      'a',
      '10',
    ]);
  });

  it('SISMEMBER は 1/0', () => {
    store.sets.set('s', new Set(['m']));
    expect(call('SISMEMBER', 's', 'm')).toBe(1);
    expect(call('SISMEMBER', 's', 'x')).toBe(0);
    expect(call('SISMEMBER', 'missing', 'm')).toBe(0);
  });
});

describe('fake store: 引数と未知コマンド', () => {
  it('Lua 数値の引数は整数へ切り捨てて文字列化される (Redis と同じ)', () => {
    dispatchRedisCommand(store, 'SET', ['k', 12.9]);
    expect(call('GET', 'k')).toBe('12');
  });

  it('未知コマンドは例外 (綴り間違いを黙って通さない)', () => {
    expect(() => call('TYPO_COMMAND', 'k', 'f', 'v')).toThrow(/Unknown Redis command/);
  });
});

describe('runRedisLua: evaluation lifetime', () => {
  const createEngine = LuaFactory.prototype.createEngine;
  let engines: LuaEngine[];
  let factories: LuaFactory[];

  beforeEach(async () => {
    await closeRedisLuaEngine();
    engines = [];
    factories = [];
    vi.spyOn(LuaFactory.prototype, 'createEngine').mockImplementation(async function (this: LuaFactory, options) {
      factories.push(this);
      const engine = await createEngine.call(this, options);
      engines.push(engine);
      return engine;
    });
  });

  afterEach(async () => {
    await closeRedisLuaEngine();
    vi.restoreAllMocks();
  });

  it('closes every engine before resolving and gives the next evaluation its own WASM heap', async () => {
    for (let i = 0; i < 3; i++) {
      expect(await runRedisLua('return 1', [], [], store)).toBe(1);
      expect(engines).toHaveLength(i + 1);
      expect(engines[i].global.isClosed()).toBe(true);
    }
    expect(new Set(await Promise.all(factories.map((factory) => factory.getLuaModule()))).size).toBe(3);
  });

  it.each([
    ['syntax', 'local =', /expected/],
    ['Lua runtime', "error('lua failure')", /lua failure/],
    ['JS callback', "return redis.call('TYPO_COMMAND')", /Unknown Redis command/],
    ['RESP conversion', "return {err='response failure'}", /response failure/],
  ])('closes on %s failure and the next evaluation still runs', async (_kind, script, message) => {
    await expect(runRedisLua(script, [], [], store)).rejects.toThrow(message);
    expect(engines[0].global.isClosed()).toBe(true);
    expect(await runRedisLua('return 7', [], [], store)).toBe(7);
    expect(engines[1].global.isClosed()).toBe(true);
  });

  it('closes even when global injection fails', async () => {
    vi.mocked(LuaFactory.prototype.createEngine).mockImplementationOnce(async function (this: LuaFactory, options) {
      const engine = await createEngine.call(this, options);
      engines.push(engine);
      vi.spyOn(engine.global, 'set').mockImplementationOnce(() => { throw new Error('injection failure'); });
      return engine;
    });
    await expect(runRedisLua('return 1', [], [], store)).rejects.toThrow('injection failure');
    expect(engines[0].global.isClosed()).toBe(true);
    expect(await runRedisLua('return 7', [], [], store)).toBe(7);
  });

  it.each([false, true])('does not carry Lua globals into the next evaluation (error=%s)', async (fail) => {
    const first = runRedisLua(`leaked = 42; ${fail ? "error('failure')" : 'return 1'}`, [], [], store);
    if (fail) await expect(first).rejects.toThrow('failure');
    else expect(await first).toBe(1);
    expect(await runRedisLua('return leaked', [], [], store)).toBeNull();
  });

  it('keeps concurrent EVALs ordered and stores isolated across a rejected call', async () => {
    const other = createFakeRedisStore();
    const script = "return redis.call('INCR', KEYS[1])";
    const results = await Promise.allSettled([
      runRedisLua(script, ['counter'], [], store),
      runRedisLua("error('failure')", [], [], store),
      runRedisLua(script, ['counter'], [], other),
      runRedisLua(script, ['counter'], [], store),
    ]);
    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'rejected', reason: expect.any(Error) },
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
    ]);
    expect(store.strings.get('counter')).toBe('2');
    expect(other.strings.get('counter')).toBe('1');
    expect(engines.every((engine) => engine.global.isClosed())).toBe(true);
  });

  it('runs 128 evaluations without accumulating return values on a shared Lua stack', async () => {
    // Wasmoon 1.16 doString leaves its return values on global's stack. Reusing that
    // state eventually writes past the stack; exercise more calls than the failing file's setup.
    for (let i = 1; i <= 128; i++) {
      const result = await runRedisLua(`
        local value = cjson.decode(ARGV[1])
        redis.call('SET', KEYS[1], cjson.encode(value))
        return {redis.call('INCR', KEYS[2]), redis.call('GET', KEYS[1])}
      `, ['record', 'counter'], [JSON.stringify({ n: i, nested: { ok: true } })], store) as [number, string];
      expect(result[0]).toBe(i);
      expect(JSON.parse(result[1])).toEqual({ n: i, nested: { ok: true } });
    }
  });
});

describe('runRedisLua: Lua → RESP 変換', () => {
  it('number は整数へ切り捨て', async () => {
    expect(await runRedisLua('return 3', [], [], store)).toBe(3);
    expect(await runRedisLua('return -1', [], [], store)).toBe(-1);
    expect(await runRedisLua('return 3.7', [], [], store)).toBe(3);
  });

  it('string はそのまま', async () => {
    expect(await runRedisLua("return 'hi'", [], [], store)).toBe('hi');
  });

  it('nil / false は null', async () => {
    expect(await runRedisLua('return nil', [], [], store)).toBeNull();
    expect(await runRedisLua('return false', [], [], store)).toBeNull();
  });

  it('true は 1', async () => {
    expect(await runRedisLua('return true', [], [], store)).toBe(1);
  });

  it('table は配列になり、nil で打ち切られる', async () => {
    expect(await runRedisLua("return {1,'a',2}", [], [], store)).toEqual([1, 'a', 2]);
    expect(await runRedisLua('return {1,nil,3}', [], [], store)).toEqual([1]);
  });

  it('{ok=...} は status / {err=...} は例外', async () => {
    expect(await runRedisLua("return {ok='PONG'}", [], [], store)).toBe('PONG');
    await expect(runRedisLua("return {err='boom'}", [], [], store)).rejects.toThrow('boom');
  });

  it('KEYS / ARGV が注入され、呼び出しをまたいで漏れない', async () => {
    expect(await runRedisLua('return KEYS[1]..ARGV[2]', ['k'], ['a', 'b'], store)).toBe('kb');
    expect(await runRedisLua('return #KEYS + #ARGV', [], [], store)).toBe(0);
  });
});

describe('runRedisLua: redis.call / pcall', () => {
  it('redis.call が fake store に届く', async () => {
    const result = await runRedisLua(
      "redis.call('SET',KEYS[1],ARGV[1]); return redis.call('GET',KEYS[1])",
      ['k'],
      ['v'],
      store,
    );
    expect(result).toBe('v');
    expect(store.strings.get('k')).toBe('v');
  });

  it('GET の nil は Lua で false になる (not c 分岐が効く)', async () => {
    expect(
      await runRedisLua("local c=redis.call('GET',KEYS[1]); if not c then return -1 end; return 1", ['k'], [], store),
    ).toBe(-1);
  });

  it('未知コマンドは pcall で捕捉できる', async () => {
    expect(
      await runRedisLua("local ok=pcall(redis.call,'TYPO_COMMAND','k'); return ok and 1 or 0", [], [], store),
    ).toBe(0);
  });

  it('redis.pcall は投げずに {err=...} を返す', async () => {
    expect(
      await runRedisLua("local r=redis.pcall('TYPO_COMMAND','k'); return type(r)=='table' and r.err~=nil and 1 or 0", [], [], store),
    ).toBe(1);
  });
});

describe('runRedisLua: cjson', () => {
  it.each([
    'local shared={n=1}; local value={left={child=shared},right={child=shared}}',
    'local value={}; value.self=value',
  ])('Upstash は同一 table の再参照で例外を投げず nil + exact error を返す: %s', async (setup) => {
    expect(await runRedisLua(`${setup}
      local ok, encoded, err = pcall(cjson.encode, value)
      return {ok, encoded == nil, err}
    `, [], [], store)).toEqual([
      1, 1,
      'json: error calling MarshalJSON for type json.jsonValue: cannot encode recursively nested tables to JSON',
    ]);
  });

  it('同じ構造の別 table は成功し、visited は encode ごとにリセットされる', async () => {
    const result = await runRedisLua(`
      local value={left={child={n=1}},right={child={n=1}}}
      local first, firstError=cjson.encode(value)
      local second, secondError=cjson.encode(value)
      return {first, firstError == nil, second, secondError == nil}
    `, [], [], store);
    expect(result).toEqual([expect.any(String), 1, expect.any(String), 1]);
    const [first, , second] = result as [string, number, string, number];
    expect(JSON.parse(first)).toEqual({ left: { child: { n: 1 } }, right: { child: { n: 1 } } });
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });

  it('decode は Lua の table を作る (userdata ではない)', async () => {
    expect(
      await runRedisLua(
        "local o=cjson.decode(ARGV[1]); return type(o)..'|'..type(o.nested)..'|'..tostring(o.n)",
        [],
        ['{"n":1,"nested":{"x":true}}'],
        store,
      ),
    ).toBe('table|table|1');
  });

  it('encode/decode の往復で値が保たれる', async () => {
    const raw = '{"a":1,"b":"x","c":true,"d":[1,2,3]}';
    const encoded = await runRedisLua('return cjson.encode(cjson.decode(ARGV[1]))', [], [raw], store);
    expect(JSON.parse(encoded as string)).toEqual(JSON.parse(raw));
  });

  it('空 table は {} にエンコードされる (本物の cjson と同じ・[] ではない)', async () => {
    expect(await runRedisLua('return cjson.encode({})', [], [], store)).toBe('{}');
    expect(await runRedisLua("return cjson.encode(cjson.decode('[]'))", [], [], store)).toBe('{}');
  });

  it('配列部を持つ table は [] にエンコードされる', async () => {
    expect(await runRedisLua('return cjson.encode({1,2,3})', [], [], store)).toBe('[1,2,3]');
  });

  it('壊れた JSON は pcall で捕捉できる', async () => {
    expect(
      await runRedisLua("local ok=pcall(cjson.decode,'{oops'); return ok and 1 or 0", [], [], store),
    ).toBe(0);
  });

  it('KNOWN DIVERGENCE: JSON の null はキーごと落ちる (本物は cjson.null)', async () => {
    expect(
      await runRedisLua(
        "local o=cjson.decode(ARGV[1]); return tostring(o.a)..'|'..tostring(o.b)",
        [],
        ['{"a":null,"b":1}'],
        store,
      ),
    ).toBe('nil|1');
  });

  it('nil 代入でキーが消える (o.verification=nil のリセットが効く)', async () => {
    const encoded = await runRedisLua(
      'local o=cjson.decode(ARGV[1]); o.b=nil; return cjson.encode(o)',
      [],
      ['{"a":1,"b":2}'],
      store,
    );
    expect(JSON.parse(encoded as string)).toEqual({ a: 1 });
  });
});

describe('restore commands', () => {
  it('RPUSH/LRANGE retain order, duplicates and Redis negative bounds', () => {
    expect(call('RPUSH', 'l', 'a', 'b', 'a')).toBe(3);
    expect(call('RPUSH', 'l', 'c')).toBe(4);
    expect(call('LRANGE', 'l', 0, -1)).toEqual(['a', 'b', 'a', 'c']);
    expect(call('LRANGE', 'l', -2, -1)).toEqual(['a', 'c']);
    expect(call('LRANGE', 'l', 0, -10)).toEqual([]);
    expect(call('LRANGE', 'l', 5, 10)).toEqual([]);
    expect(call('LRANGE', 'missing', 0, -1)).toEqual([]);
  });
  it('SADD counts only new members and SMEMBERS returns the set', () => {
    expect(call('SADD', 's', 'b', 'a', 'b')).toBe(2);
    expect(call('SADD', 's', 'a')).toBe(0);
    expect(call('SMEMBERS', 's')).toEqual(['b', 'a']);
    expect(call('SMEMBERS', 'missing')).toEqual([]);
  });
  it('HSET counts fields, replaces values, and participates in type/exists/del', () => {
    expect(call('HSET', 'h', 'b', '1', 'a', '2')).toBe(2);
    expect(call('HSET', 'h', 'b', '3')).toBe(0);
    expect(call('HGETALL', 'h')).toEqual(['b', '3', 'a', '2']);
    expect(call('TYPE', 'h')).toEqual({ ok: 'hash' });
    expect(call('EXISTS', 'h')).toBe(1);
    expect(call('DBSIZE')).toBe(1);
    expect(call('DEL', 'h')).toBe(1);
    expect(call('HGETALL', 'h')).toEqual([]);
    expect(call('DBSIZE')).toBe(0);
  });
  it('ZRANGE WITHSCORES sorts ascending and formats numeric/inf scores', () => {
    call('ZADD', 'z', '2', 'b', '1.25', 'a', '-inf', 'first', '+inf', 'last');
    expect(call('ZRANGE', 'z', 0, -1, 'WITHSCORES')).toEqual(['first', '-inf', 'a', '1.25', 'b', '2', 'last', 'inf']);
    expect(call('ZRANGE', 'z', -2, -1)).toEqual(['b', 'last']);
    expect(call('ZRANGE', 'z', 0, -10)).toEqual([]);
  });
  it('ZRANGE breaks score ties by UTF-8 bytes, including supplementary characters', () => {
    call('ZADD', 'z', '1', '𐀀', '1', '\uE000');
    expect(call('ZRANGE', 'z', 0, -1)).toEqual(['\uE000', '𐀀']);
    expect(() => call('PTTL')).toThrow('wrong number of arguments');
  });
  it('PEXPIRE/PTTL use milliseconds, including zero and all types in DBSIZE', () => {
    call('SET', 'v', 'v'); call('RPUSH', 'l', 'v'); call('SADD', 's', 'v');
    call('ZADD', 'z', '1', 'v'); call('HSET', 'h', 'f', 'v');
    expect(call('DBSIZE')).toBe(5);
    expect(call('PTTL', 'h')).toBe(-1);
    for (const k of store.keys()) expect(call('PEXPIRE', k, '1501')).toBe(1);
    store.advance(1500);
    expect(call('PTTL', 'h')).toBe(1);
    expect(call('DBSIZE')).toBe(5);
    store.advance(1);
    expect(call('PTTL', 'h')).toBe(-2);
    expect(call('DBSIZE')).toBe(0);
    expect(call('PEXPIRE', 'missing', '2')).toBe(0);
    call('SET', 'v', 'v'); call('PEXPIRE', 'v', '0');
    expect(call('EXISTS', 'v')).toBe(0);
    call('SET', 'v', 'v'); call('PEXPIRE', 'v', '500'); call('PERSIST', 'v');
    expect(call('PTTL', 'v')).toBe(-1);
  });
  it('new commands reject WRONGTYPE and malformed arguments without mutations', () => {
    call('SET', 'v', 'original');
    for (const cmd of [['RPUSH', 'v', 'a'], ['SADD', 'v', 'a'], ['HSET', 'v', 'a', 'b'], ['SMEMBERS', 'v'], ['HGETALL', 'v'], ['LRANGE', 'v', '0', '-1'], ['ZRANGE', 'v', '0', '-1']]) {
      expect(() => call(cmd[0], ...cmd.slice(1))).toThrow('WRONGTYPE');
    }
    for (const cmd of [['RPUSH', 'l'], ['SADD', 's'], ['HSET', 'h', 'f'], ['PEXPIRE', 'v', '0.5']]) {
      expect(() => call(cmd[0], ...cmd.slice(1))).toThrow();
    }
    expect(call('DBSIZE')).toBe(1);
    expect(call('GET', 'v')).toBe('original');
  });
});
