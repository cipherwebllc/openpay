// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { INSTALL_LUA, installCommand } from '@/scripts/kv-restore.mjs';
import type { BackupRecord } from '@/scripts/lib/kv-backup-core.mjs';
import { closeRedisLuaEngine, createFakeRedisStore, dispatchRedisCommand, runRedisLua, type FakeRedisStore } from '../_helpers/redisLua';
let store: FakeRedisStore;
beforeEach(() => { store = createFakeRedisStore(10_000); });
afterAll(closeRedisLuaEngine);
const call = (command: string, ...args: unknown[]) => dispatchRedisCommand(store, command, args);
async function install(record: BackupRecord) {
  const command = installCommand(record, store.now());
  return runRedisLua(INSTALL_LUA, [String(record.k)], command.slice(4).map(String), store);
}
const base = { k: 'store:test', capturedAt: 0, expiresAt: null };

describe('restore install Lua (actual script, actual Lua)', () => {
  it('EXISTS exits before SET or PEXPIRE, including a different existing type', async () => {
    call('HSET', base.k, 'f', 'original'); call('PEXPIRE', base.k, '1501');
    expect(await install({ ...base, t: 'string', s: 'replacement' })).toBe('exists');
    expect(call('HGETALL', base.k)).toEqual(['f', 'original']);
    expect(call('PTTL', base.k)).toBe(1501);
  });
  // wasmoon's JS bridge truncates NUL strings; the REST/bytes tests cover NUL without that bridge.
  it.each<BackupRecord>([
    { ...base, t: 'string', s: '\uFEFF秘密\uFFFD' },
    { ...base, t: 'list', l: ['b', 'a', 'b'] },
    { ...base, t: 'set', m: ['b', 'a'] },
    { ...base, t: 'zset', z: [['b', '2.500'], ['a', '-inf'], ['c', '+inf']] },
    { ...base, t: 'hash', h: [['b', 'v'], ['a', '秘密']] },
  ])('installs $t with PEXPIRE millisecond precision', async (r) => {
    expect(await install({ ...r, expiresAt: 11_501 })).toBe('applied');
    expect(call('TYPE', r.k)).toEqual({ ok: r.t });
    if (r.t === 'string') expect(call('GET', r.k)).toBe(r.s);
    if (r.t === 'list') expect(call('LRANGE', r.k, 0, -1)).toEqual(r.l);
    if (r.t === 'set') expect(call('SMEMBERS', r.k)).toEqual(r.m);
    if (r.t === 'hash') expect(call('HGETALL', r.k)).toEqual(r.h!.flat());
    if (r.t === 'zset') expect(call('ZRANGE', r.k, 0, -1, 'WITHSCORES')).toEqual(['a', '-inf', 'b', '2.5', 'c', 'inf']);
    expect(call('PTTL', r.k)).toBe(1501);
    store.advance(1500); expect(call('EXISTS', r.k)).toBe(1);
    store.advance(1); expect(call('EXISTS', r.k)).toBe(0);
  });
  it.each(['list', 'set', 'hash', 'zset'])('chunks unpack for 10,000 %s members/fields', async (type) => {
    const members = Array.from({ length: 10_000 }, (_, i) => `m${i}`);
    const r: BackupRecord = { ...base, t: type, ...(type === 'list' ? { l: members } : type === 'set' ? { m: members }
      : type === 'hash' ? { h: members.map((m): [string, string] => [m, `v${m}`]) } : { z: members.map((m, i): [string, string] => [m, String(i)]) }) };
    expect(await install(r)).toBe('applied');
    expect(call('PTTL', r.k)).toBe(-1);
    if (type === 'list') expect(store.lists.get(String(r.k))).toEqual(members);
    if (type === 'set') expect([...store.sets.get(String(r.k))!]).toEqual(members);
    if (type === 'hash') expect([...store.hashes.get(String(r.k))!]).toEqual(r.h);
    if (type === 'zset') expect([...store.zsets.get(String(r.k))!]).toEqual(members.map((m, i) => [m, i]));
  });
  it('Lua error after SET does not roll back the value (TTL command fails)', async () => {
    await expect(runRedisLua(INSTALL_LUA, [base.k], ['string', 'invalid-ttl', 'partial'], store)).rejects.toThrow();
    expect(call('GET', base.k)).toBe('partial');
    expect(call('PTTL', base.k)).toBe(-1);
    expect(call('DBSIZE')).toBe(1);
  });
  it('a later HSET chunk error leaves an earlier chunk installed', async () => {
    const argv = ['hash', '-1', ...Array.from({ length: 500 }, (_, i) => [`f${i}`, 'v']).flat(), 'unpaired'];
    await expect(runRedisLua(INSTALL_LUA, [base.k], argv, store)).rejects.toThrow();
    expect(store.hashes.get(base.k)?.size).toBe(500);
  });
});
