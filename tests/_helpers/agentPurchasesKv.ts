import { vi } from 'vitest';
import { createFakeRedisStore, runRedisLua } from './redisLua';

/** Real Lua at the KV boundary; GETDEL and SET NX use the same in-memory store. */
export function agentPurchasesKv(kv: {
  kvGet: ReturnType<typeof vi.fn>;
  kvMget: ReturnType<typeof vi.fn>;
  kvEval: ReturnType<typeof vi.fn>;
  kvSetNxGet: ReturnType<typeof vi.fn>;
  kvGetDel: ReturnType<typeof vi.fn>;
  kvLrange: ReturnType<typeof vi.fn>;
}) {
  const store = createFakeRedisStore();
  kv.kvGet.mockImplementation(async (key: string) => ({ ok: true, value: store.strings.get(key) ?? null }));
  kv.kvMget.mockImplementation(async (keys: readonly string[]) => ({ ok: true, value: keys.map((key) => store.strings.get(key) ?? null) }));
  kv.kvGetDel.mockImplementation(async (key: string) => {
    const value = store.strings.get(key) ?? null;
    store.strings.delete(key);
    return { ok: true, value };
  });
  kv.kvSetNxGet.mockImplementation(async (key: string, value: string, ttl: number) => {
    const old = store.strings.get(key) ?? null;
    if (old === null) {
      store.strings.set(key, value);
      store.setTtl(key, ttl);
    }
    return { ok: true, value: old };
  });
  kv.kvLrange.mockImplementation(async (key: string, start: number, stop: number) => ({
    ok: true, value: (store.lists.get(key) ?? []).slice(start, stop + 1),
  }));
  kv.kvEval.mockImplementation(async (script: string, keys: string[], args: string[]) => ({
    ok: true, value: await runRedisLua(script, keys, args, store),
  }));
  return store;
}
