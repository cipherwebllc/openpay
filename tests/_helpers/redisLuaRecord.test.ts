// @vitest-environment node
// 実 Lua ハーネスの「実行した本文の記録」(opt-in・scripts/lib/luaExecRecord.mjs) の自己テスト。
// 記録が欠けたり本文がずれたりすると、後で「どの Lua が実 Lua テストで実行されたか」を数える網が
// 偽の green を出すので、本文の一致・内容アドレス・既定で無効・tmpdir 外の拒否を固定する。
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LUA_EXEC_RECORD_ENV,
  luaExecRecordDir,
  luaScriptSha256,
  readLuaExecRecord,
  recordLuaExecution,
} from '../../scripts/lib/luaExecRecord.mjs';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, runRedisLua } from './redisLua';

const SET_SCRIPT = "redis.call('SET', KEYS[1], ARGV[1]); return 1";
const GET_SCRIPT = "return redis.call('GET', KEYS[1])";
const THIS_FILE = 'tests/_helpers/redisLuaRecord.test.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lua-exec-record-test-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(closeRedisLuaEngine);

describe('既定は無効', () => {
  it('env が無ければ記録先は null で、実行しても何も書かない', async () => {
    vi.stubEnv(LUA_EXEC_RECORD_ENV, '');
    expect(luaExecRecordDir()).toBeNull();
    await expect(runRedisLua(SET_SCRIPT, ['k'], ['v'], createFakeRedisStore())).resolves.toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('有効なとき', () => {
  beforeEach(() => {
    vi.stubEnv(LUA_EXEC_RECORD_ENV, dir);
  });

  it('runRedisLua と fakeUpstashFetch の EVAL を 1 回 1 行で記録し、本文は sha256 ごとに 1 file だけ持つ', async () => {
    const store = createFakeRedisStore();
    await runRedisLua(SET_SCRIPT, ['k'], ['v'], store);
    await runRedisLua(SET_SCRIPT, ['k'], ['w'], store);
    const res = await fakeUpstashFetch(store)('https://redis.example', {
      method: 'POST',
      body: JSON.stringify(['EVAL', GET_SCRIPT, 1, 'k']),
    });
    expect(await res.json()).toEqual({ result: 'w' });

    const { bodies, executions } = readLuaExecRecord(dir);
    expect([...bodies.keys()].sort()).toEqual([luaScriptSha256(SET_SCRIPT), luaScriptSha256(GET_SCRIPT)].sort());
    // 本文は送られた文字列そのもの (前後の包みやハーネスの shim を含めない)。
    expect(bodies.get(luaScriptSha256(SET_SCRIPT))).toBe(SET_SCRIPT);
    expect(bodies.get(luaScriptSha256(GET_SCRIPT))).toBe(GET_SCRIPT);
    expect(executions).toEqual([
      { sha256: luaScriptSha256(SET_SCRIPT), testPath: THIS_FILE },
      { sha256: luaScriptSha256(SET_SCRIPT), testPath: THIS_FILE },
      { sha256: luaScriptSha256(GET_SCRIPT), testPath: THIS_FILE },
    ]);
  });

  it('Lua が失敗した EVAL も記録する (送られた本文の記録であって成否の記録ではない)', async () => {
    const broken = 'return redis.call(';
    await expect(runRedisLua(broken, [], [], createFakeRedisStore())).rejects.toThrow();
    expect(readLuaExecRecord(dir)).toEqual({
      bodies: new Map([[luaScriptSha256(broken), broken]]),
      executions: [{ sha256: luaScriptSha256(broken), testPath: THIS_FILE }],
    });
  });

  it('sha256 は UTF-8 の本文の SHA-256 (hex) で、多バイト文字を含む本文もそのまま往復する', () => {
    // FIPS 180-2 の既知ベクトル (他の言語・ツールで同じ値を出せる = 外部から照合できる)。
    expect(luaScriptSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const script = "-- 日本語のコメント\nreturn 'ok'";
    const sha = recordLuaExecution(dir, script, undefined);
    expect(sha).toBe(createHash('sha256').update(Buffer.from(script, 'utf8')).digest('hex'));
    expect(readLuaExecRecord(dir)).toEqual({ bodies: new Map([[sha, script]]), executions: [{ sha256: sha, testPath: null }] });
  });
});

describe('記録先の制約 (repo の作業ツリーに書かない)', () => {
  it('相対パスと tmpdir の外は例外にし、runRedisLua も失敗させる (黙って別の場所に書かない)', async () => {
    expect(() => luaExecRecordDir({ [LUA_EXEC_RECORD_ENV]: 'tmp/lua-record' })).toThrow(/absolute path/);
    expect(() => luaExecRecordDir({ [LUA_EXEC_RECORD_ENV]: process.cwd() })).toThrow(/under the OS tmpdir/);
    vi.stubEnv(LUA_EXEC_RECORD_ENV, process.cwd());
    await expect(runRedisLua(SET_SCRIPT, ['k'], ['v'], createFakeRedisStore())).rejects.toThrow(/under the OS tmpdir/);
  });

  it('まだ 1 回も記録していないディレクトリは空として読む', () => {
    expect(readLuaExecRecord(dir)).toEqual({ bodies: new Map(), executions: [] });
  });
});
