// @vitest-environment node
// 期限付き利用権 (Pro / CSV パス) の原子 max-grant (GRANT_MAX_SCRIPT) を本物の Lua で実行する (第 7 回レビュー F10)。
// 支払い tx 起点の付与が「並行支払いで互いを上書きしない」「同じ tx の再適用は no-op」であることを、
// lib/kv.ts の実装ごと fake Upstash に繋いで確かめる (これまでは kvEval の JS 模倣だけだった)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { grantTimedMax } from '@/lib/timedGrant';

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const KEY = 'csvpass:0x1234567890123456789012345678901234567890';
let store: FakeRedisStore;

beforeEach(() => {
  store = createFakeRedisStore(NOW);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('GRANT_MAX_SCRIPT (real Lua)', () => {
  it('新規付与: 期限 (ms) を素の数値文字列で保存し、TTL は残り秒の切り上げ', async () => {
    expect(await grantTimedMax(KEY, NOW + DAY + 1, NOW)).toEqual({ ok: true, expiresAt: NOW + DAY + 1 });
    expect(store.strings.get(KEY)).toBe(String(NOW + DAY + 1));
    expect(store.getTtl(KEY)).toBe(86_401);
  });

  it('冪等: 同じ target の再適用は期限を変えず TTL だけ今の残りに張り直す。短い target は期限を縮めない', async () => {
    await grantTimedMax(KEY, NOW + DAY, NOW);
    store.advance(3_600_000);
    expect(await grantTimedMax(KEY, NOW + DAY, store.now())).toEqual({ ok: true, expiresAt: NOW + DAY });
    expect(store.getTtl(KEY)).toBe(82_800);
    expect(await grantTimedMax(KEY, NOW + 2 * 3_600_000, store.now())).toEqual({ ok: true, expiresAt: NOW + DAY });
    expect(store.strings.get(KEY)).toBe(String(NOW + DAY));
  });

  it('競合: 2 本の支払いが同時に付与しても、到着順によらず長い方の期限が残る', async () => {
    const results = await Promise.all([
      grantTimedMax(KEY, NOW + 30 * DAY, NOW),
      grantTimedMax(KEY, NOW + DAY, NOW),
    ]);
    expect(results.map((result) => result.expiresAt).sort()).toEqual([NOW + 30 * DAY, NOW + 30 * DAY]);
    expect(store.strings.get(KEY)).toBe(String(NOW + 30 * DAY));
    expect(store.getTtl(KEY)).toBe(30 * 86_400);
  });

  it('遅れて届いた過去期限の付与でも key を最低 1 秒残す。数値でない既存値は target で置き換える', async () => {
    expect(await grantTimedMax(KEY, NOW - DAY, NOW)).toEqual({ ok: true, expiresAt: NOW - DAY });
    expect(store.getTtl(KEY)).toBe(1);
    store.strings.set(KEY, 'corrupt');
    store.persist(KEY);
    expect(await grantTimedMax(KEY, NOW + DAY, NOW)).toEqual({ ok: true, expiresAt: NOW + DAY });
    expect(store.getTtl(KEY)).toBe(86_400);
  });

  // kvEval は Redis の値の形 (配列を含む) までしか確かめない。文字列・数でない応答で投げて支払い後の付与 route を 500 に
  // せず、未付与 (ok:false → route の 503 と同じ txHash の再試行) にする。
  it('応答が配列の形で届いても投げずに未付与 (ok:false) を返す', async () => {
    const upstash = fakeUpstashFetch(store);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = (await (await upstash(url, init)).json()) as { result?: unknown };
      return Response.json({ result: [body.result] });
    }));
    await expect(grantTimedMax(KEY, NOW + DAY, NOW)).resolves.toEqual({ ok: false, expiresAt: NOW + DAY });
  });
});
