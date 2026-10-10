// @vitest-environment node
// Web Push 購読の保存 Lua (UPSERT_SCRIPT・REMOVE_SCRIPT) を本物の Lua で実行する (Lua 登録表の計画 PR-C)。
// pushStore.test.ts は kvEval を JS で模倣しているため、上限 5 件の切り詰め・createdAt 順の並び・同じ endpoint の置換・
// 壊れた保存値の読み捨て・空になったときの DEL は CI で一度も実行されていなかった。lib/kv.ts の実装ごと fake Upstash に繋ぐ。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';

vi.mock('@/lib/env', () => ({ env: { pushVapidPublicKey: 'test-public-key' } }));

import {
  endpointHash,
  PUSH_SUBSCRIPTION_CAP,
  PUSH_SUBSCRIPTION_TTL_SEC,
  pushSubscriptionKey,
  removePushSubscription,
  upsertPushSubscription,
  type StoredPushSubscription,
} from '@/lib/push/store';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const KEY = pushSubscriptionKey(WALLET);
let store: FakeRedisStore;

beforeEach(() => {
  store = createFakeRedisStore(1_790_000_000_000);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

const endpoint = (n: number) => `https://push.example/send/${n}`;
const subscribe = (n: number, createdAt: number, over: { includeAmount?: boolean; locale?: 'ja' | 'en' } = {}) =>
  upsertPushSubscription(WALLET, {
    endpoint: endpoint(n),
    keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
    locale: over.locale ?? 'ja',
    includeAmount: over.includeAmount,
    nowMs: createdAt,
  });
const saved = () => JSON.parse(store.strings.get(KEY)!) as StoredPushSubscription[];
const endpoints = (list: StoredPushSubscription[]) => list.map((item) => item.endpoint);

describe('UPSERT_SCRIPT (real Lua)', () => {
  it('新しい購読を保存し、保存した一覧そのものを返し、90 日の TTL を付ける', async () => {
    const result = await subscribe(1, 1_000, { includeAmount: true });
    expect(result.ok).toBe(true);
    const expected: StoredPushSubscription = {
      endpointHash: endpointHash(endpoint(1)),
      endpoint: endpoint(1),
      keys: { p256dh: 'p256dh-1', auth: 'auth-1' },
      locale: 'ja',
      vapidKeyId: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown as string,
      includeAmount: true,
      createdAt: 1_000,
    };
    expect(result).toEqual({ ok: true, value: [expected] });
    expect(saved()).toEqual([expected]);
    expect(store.getTtl(KEY)).toBe(PUSH_SUBSCRIPTION_TTL_SEC);
  });

  it('同じ endpoint は 1 件のまま置き換え (locale・includeAmount・createdAt も新しい値)、TTL を張り直す', async () => {
    await subscribe(1, 1_000, { includeAmount: true });
    await subscribe(2, 2_000);
    store.advance(60_000);
    const result = await subscribe(1, 3_000, { locale: 'en', includeAmount: false });
    expect(result.ok).toBe(true);
    expect(endpoints(saved())).toEqual([endpoint(2), endpoint(1)]);
    expect(saved()[1]).toMatchObject({ locale: 'en', includeAmount: false, createdAt: 3_000 });
    expect(store.getTtl(KEY)).toBe(PUSH_SUBSCRIPTION_TTL_SEC);
  });

  it(`createdAt の古い順に並べ、上限 ${PUSH_SUBSCRIPTION_CAP} 件を超えたら最も古いものから落とす (追加順ではない)`, async () => {
    for (const [n, createdAt] of [[1, 5_000], [2, 1_000], [3, 4_000], [4, 2_000], [5, 3_000]] as const) {
      await subscribe(n, createdAt);
    }
    expect(endpoints(saved())).toEqual([endpoint(2), endpoint(4), endpoint(5), endpoint(3), endpoint(1)]);
    const result = await subscribe(6, 6_000);
    expect(result.ok && endpoints(result.value)).toEqual([endpoint(4), endpoint(5), endpoint(3), endpoint(1), endpoint(6)]);
    expect(saved()).toHaveLength(PUSH_SUBSCRIPTION_CAP);
  });

  it('上限で落ちるのは新しい購読自身のこともある (既存より古い createdAt)', async () => {
    for (let n = 1; n <= PUSH_SUBSCRIPTION_CAP; n += 1) await subscribe(n, n * 1_000);
    await subscribe(9, 500);
    expect(endpoints(saved())).toEqual([1, 2, 3, 4, 5].map(endpoint));
  });

  it('壊れた保存値と形の違う要素は読み捨てて、有効な要素だけで作り直す (購読を止めない)', async () => {
    store.strings.set(KEY, 'not-json');
    expect((await subscribe(1, 1_000)).ok).toBe(true);
    expect(endpoints(saved())).toEqual([endpoint(1)]);

    const kept = saved()[0];
    store.strings.set(KEY, JSON.stringify([kept, { endpoint: 'no-hash' }, 'text', { endpointHash: 7 }]));
    await subscribe(2, 2_000);
    expect(endpoints(saved())).toEqual([endpoint(1), endpoint(2)]);
  });
});

describe('REMOVE_SCRIPT (real Lua)', () => {
  it('endpoint の hash が一致する購読だけを消し、残りを返して TTL を張り直す', async () => {
    await subscribe(1, 1_000);
    await subscribe(2, 2_000);
    await subscribe(3, 3_000);
    store.advance(60_000);
    const result = await removePushSubscription(WALLET, { endpoint: endpoint(2) });
    expect(result.ok && endpoints(result.value)).toEqual([endpoint(1), endpoint(3)]);
    expect(endpoints(saved())).toEqual([endpoint(1), endpoint(3)]);
    expect(store.getTtl(KEY)).toBe(PUSH_SUBSCRIPTION_TTL_SEC);
  });

  it('最後の 1 件を消すとキーごと DEL し、空配列 [] を返す (cjson の空 table {} を返さない)', async () => {
    await subscribe(1, 1_000);
    const result = await removePushSubscription(WALLET, { endpointHash: endpointHash(endpoint(1)) });
    expect(result).toEqual({ ok: true, value: [] });
    expect(store.keys()).not.toContain(KEY);
  });

  it('冪等: 未登録の endpoint の削除は何も消さず、未保存のキーには [] を返す', async () => {
    expect(await removePushSubscription(WALLET, { endpoint: endpoint(1) })).toEqual({ ok: true, value: [] });
    await subscribe(1, 1_000);
    const result = await removePushSubscription(WALLET, { endpoint: endpoint(9) });
    expect(result.ok && endpoints(result.value)).toEqual([endpoint(1)]);
  });
});
