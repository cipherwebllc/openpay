import { createFakeRedisStore, type FakeRedisStore } from './redisLua';

export type LuaCall = {
  script: string;
  keys: string[];
  args: string[];
  before: FakeRedisStore;
};

// Copy only Redis data, never Lua behavior. Replaying a captured invocation
// exercises the production caller's exact positional protocol against races.
export function copyRedisStore(store: FakeRedisStore): FakeRedisStore {
  const copy = createFakeRedisStore(store.now());
  for (const key of store.keys()) {
    if (store.strings.has(key)) copy.strings.set(key, store.strings.get(key)!);
    if (store.lists.has(key)) copy.lists.set(key, [...store.lists.get(key)!]);
    if (store.zsets.has(key)) copy.zsets.set(key, new Map(store.zsets.get(key)!));
    if (store.sets.has(key)) copy.sets.set(key, new Set(store.sets.get(key)!));
    if (store.hashes.has(key)) copy.hashes.set(key, new Map(store.hashes.get(key)!));
    const ttl = store.getPttl(key);
    if (ttl >= 0) copy.setPttl(key, ttl);
  }
  return copy;
}

export function redisState(store: FakeRedisStore) {
  return structuredClone({
    strings: store.strings,
    lists: store.lists,
    zsets: store.zsets,
    sets: store.sets,
    hashes: store.hashes,
    ttl: store.keys().map((key) => [key, store.getPttl(key)]),
  });
}

export function captureLuaCall(
  script: string, keys: string[], args: string[], store: FakeRedisStore,
): LuaCall {
  return { script, keys: [...keys], args: [...args], before: copyRedisStore(store) };
}
