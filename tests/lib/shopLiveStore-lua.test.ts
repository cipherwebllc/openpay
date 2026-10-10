// @vitest-environment node
// 営業中表示 (売り切れ・受付一時停止) の楽観 CAS の Lua (CAS_SET) を本物の Lua で実行する (Lua 登録表の計画 PR-C)。
// shopLiveStore.test.ts は kvEval を JS で模倣しているため、「未保存は空文字 sentinel で比べる」「読んだ値と違えば 0 で書かない」
// ことは CI で一度も実行されていなかった。lib/shopLiveStore.ts を lib/kv.ts の実装ごと fake Upstash に繋ぐ (mock なし)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { applyShopLive } from '@/lib/shopLiveStore';
import { serializeShopLive, shopLiveKey } from '@/lib/shopLive';

const KEY = shopLiveKey('Coffee');
const h = vi.hoisted(() => ({
  // EVAL の直前に毎回実行する (別端末の同時トグルを Lua の手前に差し込む)。
  beforeEval: null as (() => void) | null,
  evals: 0,
}));
let store: FakeRedisStore;

beforeEach(() => {
  store = createFakeRedisStore(1_790_000_000_000);
  h.beforeEval = null;
  h.evals = 0;
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  const upstash = fakeUpstashFetch(store);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    if (body[0] === 'EVAL') {
      h.evals += 1;
      h.beforeEval?.();
    }
    return upstash(url, init);
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

const saved = () => JSON.parse(store.strings.get(KEY)!) as unknown;

describe('CAS_SET (real Lua)', () => {
  it('未保存のキーには空文字 sentinel で比べて書き、保存済みなら読んだ値と一致するときだけ置き換える', async () => {
    expect(await applyShopLive('coffee', { op: 'soldOut', itemId: 'a', value: true }, 1_000)).toEqual({
      ok: true,
      state: { soldOut: ['a'], paused: false, updatedAt: 1_000 },
    });
    expect(saved()).toEqual({ soldOut: ['a'], paused: false, updatedAt: 1_000 });
    expect(await applyShopLive('coffee', { op: 'paused', value: true }, 2_000)).toMatchObject({ ok: true });
    expect(saved()).toEqual({ soldOut: ['a'], paused: true, updatedAt: 2_000 });
    expect(h.evals).toBe(2);
  });

  it('競合: 未保存と読んだ直後に別端末がキーを作ったら 0 → 読み直して、相手の状態の上に適用する', async () => {
    let first = true;
    h.beforeEval = () => {
      if (!first) return;
      first = false;
      store.strings.set(KEY, serializeShopLive({ soldOut: ['b'], paused: true, updatedAt: 500 }));
    };
    expect(await applyShopLive('coffee', { op: 'soldOut', itemId: 'a', value: true }, 1_000)).toEqual({
      ok: true,
      state: { soldOut: ['b', 'a'], paused: true, updatedAt: 1_000 },
    });
    expect(h.evals).toBe(2);
    expect(saved()).toEqual({ soldOut: ['b', 'a'], paused: true, updatedAt: 1_000 });
  });

  it('競合: 読んだ値が Lua の直前に変わっていたら書かず、読み直した値で書き直す (lost update を作らない)', async () => {
    store.strings.set(KEY, serializeShopLive({ soldOut: [], paused: false, updatedAt: 100 }));
    let first = true;
    h.beforeEval = () => {
      if (!first) return;
      first = false;
      store.strings.set(KEY, serializeShopLive({ soldOut: ['z'], paused: false, updatedAt: 200 }));
    };
    expect(await applyShopLive('coffee', { op: 'paused', value: true }, 1_000)).toMatchObject({ ok: true });
    expect(saved()).toEqual({ soldOut: ['z'], paused: true, updatedAt: 1_000 });
    expect(h.evals).toBe(2);
  });

  it('競合: 3 回続けて Lua の直前に書き換えられたら conflict で、相手の最後の版を残す', async () => {
    let n = 0;
    h.beforeEval = () => {
      n += 1;
      store.strings.set(KEY, serializeShopLive({ soldOut: [`x${n}`], paused: false, updatedAt: n }));
    };
    expect(await applyShopLive('coffee', { op: 'paused', value: true }, 1_000)).toEqual({ ok: false, reason: 'conflict' });
    expect(h.evals).toBe(3);
    expect(saved()).toEqual({ soldOut: ['x3'], paused: false, updatedAt: 3 });
  });

  it('競合: 保存済みのキーが Lua の直前に消えたら (空文字と一致しない) 書かずに読み直す', async () => {
    store.strings.set(KEY, serializeShopLive({ soldOut: ['a'], paused: false, updatedAt: 100 }));
    let first = true;
    h.beforeEval = () => {
      if (!first) return;
      first = false;
      store.delete(KEY);
    };
    expect(await applyShopLive('coffee', { op: 'paused', value: true }, 1_000)).toEqual({
      ok: true,
      state: { soldOut: [], paused: true, updatedAt: 1_000 },
    });
    expect(h.evals).toBe(2);
  });
});
