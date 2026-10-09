// @vitest-environment node
// 購入ライブラリのページ読み (READ_LIBRARY_PAGE) を本物の Lua で実行する (第 7 回レビュー F10)。
// ZREVRANK でページ境界を引き直す分岐 (cursor の検証・同 score の member 降順・型の検査) は、これまで
// kvEval の戻り値を手で並べた test (storeEntitlement.test.ts) でしか確かめていなかった。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '@/tests/_helpers/redisLua';

const PAYER = '0x1111111111111111111111111111111111111111';
const SCORE = 1_700_000_000_000;
const h = vi.hoisted(() => ({ store: null as FakeRedisStore | null }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStore: true, enableLicenseNft: false } };
});
vi.mock('@/lib/kv', () => ({
  kvEval: async (script: string, keys: string[], args: string[]) =>
    ({ ok: true, value: await runRedisLua(script, keys, args, h.store!) }),
  kvGet: async (key: string) => ({ ok: true, value: h.store!.strings.get(key) ?? null }),
  kvMget: async (keys: string[]) => ({ ok: true, value: keys.map((key) => h.store!.strings.get(key) ?? null) }),
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  isHostedId: (value: unknown) => typeof value === 'string' && /^h_[0-9a-f]{32}$/.test(value),
}));
vi.mock('@/lib/x402/purchaseIntent', () => ({
  purchaseLibraryKey: (payer: string) => `store:lib:${payer.toLowerCase()}`,
  purchaseOwnershipKey: (payer: string, resourceId: string) => `store:own:${payer.toLowerCase()}:${resourceId}`,
  parsePurchaseOwnership: (raw: unknown) => (typeof raw === 'string' ? JSON.parse(raw) as unknown : null),
}));

import { listStoreLibraryPage, STORE_LIBRARY_PAGE_SIZE } from '@/lib/x402/storeEntitlement';

const LIBRARY = `store:lib:${PAYER}`;
const resource = (n: number) => `h_${n.toString(16).padStart(32, '0')}`;

function purchase(resourceId: string, score = SCORE) {
  const grant = {
    intentSalt: `0x${'a'.repeat(64)}`,
    contentRevision: 1,
    metadata: { title: resourceId.slice(-4), priceJpyc: '300', contentKind: 'text', label: 'prompt' },
    purchasedAt: score,
  };
  h.store!.strings.set(`store:own:${PAYER}:${resourceId}`, JSON.stringify({
    payer: PAYER, resourceId, firstPurchasedAt: score, grants: [grant], latestGrant: grant,
  }));
  const zset = h.store!.zsets.get(LIBRARY) ?? new Map<string, number>();
  zset.set(resourceId, score);
  h.store!.zsets.set(LIBRARY, zset);
}

async function page(cursor: string | null) {
  const result = await listStoreLibraryPage({ payer: PAYER, cursor });
  if (!result.ok) throw new Error(result.reason);
  return { ids: result.page.items.map((item) => item.resourceId), next: result.page.nextCursor };
}

const cursorOf = (score: number, member: string) =>
  Buffer.from(JSON.stringify({ score, member }), 'utf8').toString('base64url');

beforeEach(() => {
  h.store = createFakeRedisStore(SCORE);
});
afterAll(closeRedisLuaEngine);

describe('READ_LIBRARY_PAGE (real Lua)', () => {
  it('score 降順・同 score は member 降順で 24 件ずつ読み、次ページは cursor の直後から始まる', async () => {
    for (let n = 1; n <= STORE_LIBRARY_PAGE_SIZE + 1; n += 1) purchase(resource(n));
    purchase(resource(100), SCORE + 1);
    const all = [resource(100), ...Array.from({ length: STORE_LIBRARY_PAGE_SIZE + 1 }, (_, i) => resource(STORE_LIBRARY_PAGE_SIZE + 1 - i))];

    const first = await page(null);
    expect(first.ids).toEqual(all.slice(0, STORE_LIBRARY_PAGE_SIZE));
    const second = await page(first.next);
    expect(second).toEqual({ ids: all.slice(STORE_LIBRARY_PAGE_SIZE), next: null });
  });

  it('冪等: ページの間に新しい購入が先頭へ入っても、同じ cursor の次ページは重複も欠落も起こさない', async () => {
    for (let n = 1; n <= STORE_LIBRARY_PAGE_SIZE + 2; n += 1) purchase(resource(n));
    const first = await page(null);
    const before = await page(first.next);
    purchase(resource(200), SCORE + 10);
    expect(await page(first.next)).toEqual(before);
    expect(before.ids).toEqual([resource(2), resource(1)]);
  });

  it('競合: cursor の tuple が index から消えた・score が変わったときは invalid_cursor (別ページを黙って返さない)', async () => {
    purchase(resource(1));
    purchase(resource(2));
    expect(await listStoreLibraryPage({ payer: PAYER, cursor: cursorOf(SCORE, resource(9)) }))
      .toEqual({ ok: false, reason: 'invalid_cursor' });
    expect(await listStoreLibraryPage({ payer: PAYER, cursor: cursorOf(SCORE + 1, resource(2)) }))
      .toEqual({ ok: false, reason: 'invalid_cursor' });
    expect(await page(cursorOf(SCORE, resource(2)))).toEqual({ ids: [resource(1)], next: null });
  });

  it('index が無ければ空ページ、zset 以外の型なら corrupt', async () => {
    expect(await page(null)).toEqual({ ids: [], next: null });
    h.store!.strings.set(LIBRARY, 'not-a-zset');
    expect(await listStoreLibraryPage({ payer: PAYER, cursor: null })).toEqual({ ok: false, reason: 'corrupt' });
  });
});
