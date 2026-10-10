// @vitest-environment node
// @handle の claim / CAS 更新 / release と Shops API 掲載同期の Lua (CLAIM_HANDLE・CAS_UPDATE・RELEASE_HANDLE・
// AGENT_LISTING_LUA) を本物の Lua で実行する (Lua 登録表の計画 PR-C)。handleStore.test.ts・handleStoreAgentListing.test.ts は
// kvEval を JS で模倣しているため、Lua の 10 進比較・string.sub(KEYS[1],8) の handle 名取り出し・index 満杯の判定は
// CI で一度も実行されていなかった。ここでは lib/handleStore.ts を lib/kv.ts の実装ごと fake Upstash に繋ぐ (mock なし)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import {
  AGENT_SHOP_INDEX_KEY,
  AGENT_SHOP_INDEX_MAX,
  agentShopSummaryKey,
  releaseHandle,
  reserveOrUpdateHandle,
} from '@/lib/handleStore';
import type { HandleRecord, HandleTipConfig } from '@/lib/handle';
import type { StorefrontParts } from '@/lib/mobileOrder';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const OWNER_INDEX = `wallet:handles:${OWNER.toLowerCase()}`;
const CONFIG: HandleTipConfig = { to: OWNER, name: '設定の店名', methods: [{ token: 'jpyc', chain: 'polygon' }] };
const LISTED: StorefrontParts = {
  chain: 'polygon',
  chains: ['polygon', 'kaia'],
  mode: 'storefront',
  feePayer: 'merchant',
  shopName: '掲載珈琲店',
  tagline: '焼きたてと淹れたて',
  dineIn: true,
  minLeadMinutes: 20,
  menu: [
    { id: 'a', name: 'ブレンド', price: '500' },
    { id: 'b', name: '水', price: '9.5' },
  ],
  agentListing: true,
};

const h = vi.hoisted(() => ({
  // 次の EVAL の直前に 1 回だけ実行する (別端末の同時更新を Lua の手前に差し込む)。
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
      const hook = h.beforeEval;
      h.beforeEval = null;
      hook?.();
    }
    return upstash(url, init);
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

const stored = (handle: string) => JSON.parse(store.strings.get(`handle:${handle}`)!) as HandleRecord;
const summary = (handle: string) => {
  const raw = store.strings.get(agentShopSummaryKey(handle));
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
};
const agentIndex = () => store.lists.get(AGENT_SHOP_INDEX_KEY) ?? [];

function claim(handle: string, over: { owner?: string; storefront?: StorefrontParts; config?: HandleTipConfig } = {}) {
  return reserveOrUpdateHandle({
    handle,
    owner: over.owner ?? OWNER,
    config: over.config ?? CONFIG,
    ...(over.storefront ? { storefront: over.storefront } : {}),
    nowMs: 1_000,
  });
}

function update(handle: string, expectedUpdatedAt: number, storefront: StorefrontParts | null | undefined, nowMs = 2_000) {
  return reserveOrUpdateHandle({ handle, owner: OWNER, config: CONFIG, storefront, expectedUpdatedAt, nowMs });
}

describe('CLAIM_HANDLE (real Lua)', () => {
  it('新規 claim は record 保存・所有 index 追記・旧 live 状態の失効を 1 EVAL で行う', async () => {
    store.strings.set('shop:live:alice', '{"paused":true}');
    const result = await claim('alice');
    expect(result).toMatchObject({ status: 'created' });
    expect(result).not.toHaveProperty('listing');
    expect(stored('alice')).toEqual({ owner: OWNER, config: CONFIG, createdAt: 1_000, updatedAt: 1_000 });
    expect(store.lists.get(OWNER_INDEX)).toEqual(['alice']);
    expect(store.strings.has('shop:live:alice')).toBe(false);
    // 掲載しない店は Shops API の index にも summary にも触れない。
    expect(store.lists.has(AGENT_SHOP_INDEX_KEY)).toBe(false);
    expect(summary('alice')).toBeUndefined();
    expect(h.evals).toBe(1);
  });

  it('競合: 同じ handle の同時 claim は 1 人だけが取り、負けた側は 0 → taken で何も書かない', async () => {
    const results = await Promise.all([claim('alice'), claim('alice', { owner: OTHER })]);
    expect(results.map((r) => r.status).sort()).toEqual(['created', 'taken']);
    const winner = results[0].status === 'created' ? OWNER : OTHER;
    const loser = winner === OWNER ? OTHER : OWNER;
    expect(stored('alice').owner).toBe(winner);
    expect(store.lists.get(`wallet:handles:${winner.toLowerCase()}`)).toEqual(['alice']);
    expect(store.lists.has(`wallet:handles:${loser.toLowerCase()}`)).toBe(false);
  });

  it('所有数上限: index の raw LLEN が上限 (3) 以上なら -2 → limit で、record も index も live も変えない', async () => {
    store.lists.set(OWNER_INDEX, ['a', 'b']);
    expect(await claim('c1')).toMatchObject({ status: 'created' });
    expect(store.lists.get(OWNER_INDEX)).toEqual(['c1', 'a', 'b']);
    store.strings.set('shop:live:d1', '{"paused":true}');
    expect(await claim('d1')).toEqual({ status: 'limit' });
    expect(store.strings.has('handle:d1')).toBe(false);
    expect(store.lists.get(OWNER_INDEX)).toEqual(['c1', 'a', 'b']);
    expect(store.strings.get('shop:live:d1')).toBe('{"paused":true}');
  });

  it('掲載 opt-in の新規 claim は同じ EVAL で index と summary も作る', async () => {
    expect(await claim('alice', { storefront: LISTED })).toMatchObject({ status: 'created' });
    expect(agentIndex()).toEqual(['alice']);
    expect(summary('alice')).toEqual({
      handle: 'alice',
      name: '掲載珈琲店',
      mode: 'storefront',
      dineIn: true,
      acceptingOrders: true,
      chain: 'polygon',
      chains: ['polygon', 'kaia'],
      menu: { itemCount: 2, minPrice: '9.5', maxPrice: '500', itemIds: ['a', 'b'] },
      updatedAt: 1_000,
      tagline: '焼きたてと淹れたて',
      minLeadMinutes: 20,
    });
    expect(h.evals).toBe(1);
  });
});

describe('AGENT_LISTING_LUA (real Lua)', () => {
  it('menu の最小・最大価格は decimal 文字列のまま 10 進で比べる (辞書順でも Number 化でもない)', async () => {
    const menu = ['500', '1200', '9.99', '1200.000000000000000001', '10', '5', '0500.50'].map((price, i) => ({
      id: `m${i}`,
      name: `品${i}`,
      price,
    }));
    await claim('alice', { storefront: { ...LISTED, menu } });
    // 辞書順なら min='0500.50'/max='9.99'、Number 化なら max='1200' (18 桁目が丸めで消える)。
    expect(summary('alice')).toMatchObject({
      menu: { itemCount: 7, minPrice: '5', maxPrice: '1200.000000000000000001', itemIds: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'] },
    });
  });

  it('店名は shopName → config.name → @handle の順に決め、chains が無ければ単一 chain、受付停止はそのまま写す', async () => {
    const { shopName: _omit, chains: _chains, tagline: _tagline, minLeadMinutes: _lead, ...bare } = LISTED;
    await claim('alice', { storefront: { ...bare, acceptingOrders: false, dineIn: undefined } });
    expect(summary('alice')).toEqual({
      handle: 'alice',
      name: '設定の店名',
      mode: 'storefront',
      dineIn: false,
      acceptingOrders: false,
      chain: 'polygon',
      chains: ['polygon'],
      menu: { itemCount: 2, minPrice: '9.5', maxPrice: '500', itemIds: ['a', 'b'] },
      updatedAt: 1_000,
    });
    const { name: _name, ...unnamed } = CONFIG;
    await claim('bob', { storefront: bare, config: unnamed });
    expect(summary('bob')).toMatchObject({ handle: 'bob', name: '@bob' });
  });
});

describe('CAS_UPDATE (real Lua)', () => {
  it('owner と updatedAt が一致すれば置換し、掲載 index には KEYS[1] から取った handle 名 (string.sub(KEYS[1],8)) で入る', async () => {
    await claim('alice');
    const result = await update('alice', 1_000, LISTED);
    expect(result).toMatchObject({ status: 'updated' });
    expect(stored('alice')).toMatchObject({ storefront: LISTED, createdAt: 1_000, updatedAt: 2_000 });
    expect(agentIndex()).toEqual(['alice']);
    expect(summary('alice')).toMatchObject({ handle: 'alice', updatedAt: 2_000 });
    expect(store.keys().filter((key) => key.startsWith('shops:summary:'))).toEqual([agentShopSummaryKey('alice')]);
  });

  it('opt-out の更新は index から全重複を除き summary を消す (他の店の掲載は残す)', async () => {
    await claim('alice', { storefront: LISTED });
    store.lists.set(AGENT_SHOP_INDEX_KEY, ['bob', 'alice', 'carol', 'alice']);
    store.strings.set(agentShopSummaryKey('bob'), '{"handle":"bob"}');
    expect(await update('alice', 1_000, null)).toMatchObject({ status: 'updated' });
    expect(stored('alice')).not.toHaveProperty('storefront');
    expect(agentIndex()).toEqual(['bob', 'carol']);
    expect(summary('alice')).toBeUndefined();
    expect(summary('bob')).toEqual({ handle: 'bob' });
  });

  it('掲載中の再更新は index を重複させず先頭へ移し、summary を新しい内容で置き換える', async () => {
    await claim('alice', { storefront: LISTED });
    store.lists.set(AGENT_SHOP_INDEX_KEY, ['bob', 'alice']);
    const menu = [{ id: 'z', name: 'ラテ', price: '650' }];
    expect(await update('alice', 1_000, { ...LISTED, menu })).toMatchObject({ status: 'updated' });
    expect(agentIndex()).toEqual(['alice', 'bob']);
    expect(summary('alice')).toMatchObject({ menu: { itemCount: 1, minPrice: '650', maxPrice: '650', itemIds: ['z'] }, updatedAt: 2_000 });
  });

  it(`index 満杯 (${AGENT_SHOP_INDEX_MAX}) の未掲載店は 2 → index_full: record は保存し、summary は作らず、既存の店を落とさない`, async () => {
    await claim('alice');
    const others = Array.from({ length: AGENT_SHOP_INDEX_MAX }, (_, i) => `shop${i}`);
    store.lists.set(AGENT_SHOP_INDEX_KEY, [...others]);
    store.strings.set(agentShopSummaryKey('alice'), '{"stale":true}');
    expect(await update('alice', 1_000, LISTED)).toMatchObject({ status: 'updated', listing: 'index_full' });
    expect(stored('alice')).toMatchObject({ storefront: LISTED, updatedAt: 2_000 });
    expect(agentIndex()).toEqual(others);
    expect(summary('alice')).toBeUndefined();
  });

  it('index 満杯でも既に掲載中の店は 1 (掲載を続ける)', async () => {
    await claim('alice', { storefront: LISTED });
    const others = Array.from({ length: AGENT_SHOP_INDEX_MAX - 1 }, (_, i) => `shop${i}`);
    store.lists.set(AGENT_SHOP_INDEX_KEY, [...others, 'alice']);
    const result = await update('alice', 1_000, LISTED);
    expect(result).toMatchObject({ status: 'updated' });
    expect(result).not.toHaveProperty('listing');
    expect(agentIndex()).toEqual(['alice', ...others]);
    expect(summary('alice')).toMatchObject({ updatedAt: 2_000 });
  });

  it('競合: Lua の直前に別端末が更新したら -3 → conflict で、相手の更新を上書きしない', async () => {
    await claim('alice');
    const concurrent = JSON.stringify({ owner: OWNER, config: CONFIG, createdAt: 1_000, updatedAt: 1_500 });
    h.beforeEval = () => store.strings.set('handle:alice', concurrent);
    expect(await update('alice', 1_000, LISTED)).toEqual({ status: 'conflict' });
    expect(store.strings.get('handle:alice')).toBe(concurrent);
    expect(store.lists.has(AGENT_SHOP_INDEX_KEY)).toBe(false);
  });

  const takenOver = JSON.stringify({ owner: OTHER, config: CONFIG, createdAt: 1, updatedAt: 1_000 });
  it.each([
    ['別 owner への入れ替わり (0)', takenOver],
    ['消失 (-1)', undefined],
    ['破損 (-2)', 'not-json'],
  ])('競合: Lua の直前の record の%s は taken で、record・index・summary を書かない', async (_name, raw) => {
    await claim('alice');
    h.beforeEval = () => {
      if (raw === undefined) store.delete('handle:alice');
      else store.strings.set('handle:alice', raw);
    };
    expect(await update('alice', 1_000, LISTED)).toEqual({ status: 'taken' });
    expect(store.strings.get('handle:alice')).toBe(raw);
    expect(store.lists.has(AGENT_SHOP_INDEX_KEY)).toBe(false);
    expect(summary('alice')).toBeUndefined();
  });
});

describe('RELEASE_HANDLE (real Lua)', () => {
  it('owner 一致 (大文字小文字を問わない) なら handle・所有 index・live・掲載 index・summary をまとめて消す', async () => {
    await claim('alice', { storefront: LISTED });
    store.lists.set(OWNER_INDEX, ['bob', 'alice']);
    store.lists.set(AGENT_SHOP_INDEX_KEY, ['bob', 'alice']);
    store.strings.set(agentShopSummaryKey('bob'), '{"handle":"bob"}');
    store.strings.set('shop:live:alice', '{"paused":false}');
    expect(await releaseHandle({ handle: 'alice', owner: OWNER.toLowerCase() })).toBe('released');
    expect(store.strings.has('handle:alice')).toBe(false);
    expect(store.lists.get(OWNER_INDEX)).toEqual(['bob']);
    expect(store.strings.has('shop:live:alice')).toBe(false);
    expect(agentIndex()).toEqual(['bob']);
    expect(summary('alice')).toBeUndefined();
    expect(summary('bob')).toEqual({ handle: 'bob' });
    // 冪等: 2 回目は消失 (-1) → not_found。
    expect(await releaseHandle({ handle: 'alice', owner: OWNER })).toBe('not_found');
  });

  it('別 owner は 0 → forbidden で、どのキーも消さない', async () => {
    await claim('alice', { storefront: LISTED });
    store.strings.set('shop:live:alice', '{"paused":false}');
    const snapshot = JSON.stringify([...store.keys()].sort());
    expect(await releaseHandle({ handle: 'alice', owner: OTHER })).toBe('forbidden');
    expect(JSON.stringify([...store.keys()].sort())).toBe(snapshot);
    expect(agentIndex()).toEqual(['alice']);
  });

  it.each([
    ['JSON でない', 'not-json'],
    ['owner が文字列でない', JSON.stringify({ owner: 5, config: CONFIG, createdAt: 1, updatedAt: 1 })],
  ])('壊れた record (%s) は -2 → not_found で、record も index も消さない', async (_name, raw) => {
    store.strings.set('handle:alice', raw);
    store.lists.set(OWNER_INDEX, ['alice']);
    expect(await releaseHandle({ handle: 'alice', owner: OWNER })).toBe('not_found');
    expect(store.strings.get('handle:alice')).toBe(raw);
    expect(store.lists.get(OWNER_INDEX)).toEqual(['alice']);
  });
});
