import { beforeEach, describe, expect, it, vi } from 'vitest';

// PR-1 の Shops API index/summary 専用フェンス。既存 handleStore.test.ts は無変更のまま残し、
// 既存 KEYS/ARGV 契約を保った Lua が handle record と掲載状態を同じ EVAL で更新することを検証する。
const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  lists: new Map<string, string[]>(),
}));
const kv = vi.hoisted(() => ({
  isKvConfigured: vi.fn(() => true),
  kvGet: vi.fn(),
  kvLrange: vi.fn(),
  kvEval: vi.fn(),
}));
vi.mock('@/lib/kv', () => kv);

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
const CONFIG: HandleTipConfig = {
  to: OWNER,
  name: '設定の店名',
  methods: [{ token: 'jpyc', chain: 'polygon' }],
};
const LISTED_STORE: StorefrontParts = {
  chain: 'polygon',
  chains: ['polygon', 'kaia'],
  mode: 'storefront',
  feePayer: 'merchant',
  shopName: '掲載珈琲店',
  tagline: '焼きたてと淹れたて',
  address: '東京都千代田区1-2-3',
  dineIn: true,
  openFrom: '09:30',
  lastOrder: '21:30',
  minLeadMinutes: 20,
  menu: [
    { id: 'a', name: 'ブレンド', price: '500' },
    { id: 'b', name: '水', price: '9.5' },
    { id: 'c', name: 'コース', price: '1200.000000000000000001' },
  ],
  agentListing: true,
};
const UNLISTED_STORE: StorefrontParts = {
  ...LISTED_STORE,
  agentListing: undefined,
};

function record(input: {
  storefront?: StorefrontParts;
  config?: HandleTipConfig;
  owner?: string;
  createdAt?: number;
  updatedAt?: number;
} = {}): HandleRecord {
  return {
    owner: input.owner ?? OWNER,
    config: input.config ?? CONFIG,
    ...(input.storefront ? { storefront: input.storefront } : {}),
    createdAt: input.createdAt ?? 10,
    updatedAt: input.updatedAt ?? 10,
  };
}

function saveRecord(handle: string, value: HandleRecord) {
  state.values.set(`handle:${handle}`, JSON.stringify(value));
}

function decimalAtomic(value: string): bigint {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

function syncAgentListing(
  value: HandleRecord,
  handle: string,
  cleanup: boolean,
): 1 | 2 {
  const index = state.lists.get(AGENT_SHOP_INDEX_KEY) ?? [];
  const storefront = value.storefront;
  if (storefront?.agentListing !== true) {
    if (cleanup) {
      state.lists.set(
        AGENT_SHOP_INDEX_KEY,
        index.filter((entry) => entry !== handle),
      );
      state.values.delete(agentShopSummaryKey(handle));
    }
    return 1;
  }

  const alreadyListed = index.includes(handle);
  if (!alreadyListed && index.length >= AGENT_SHOP_INDEX_MAX) {
    state.values.delete(agentShopSummaryKey(handle));
    return 2;
  }
  state.lists.set(AGENT_SHOP_INDEX_KEY, [
    handle,
    ...index.filter((entry) => entry !== handle),
  ]);

  let minPrice = storefront.menu[0].price;
  let maxPrice = minPrice;
  for (const item of storefront.menu.slice(1)) {
    if (decimalAtomic(item.price) < decimalAtomic(minPrice)) minPrice = item.price;
    if (decimalAtomic(item.price) > decimalAtomic(maxPrice)) maxPrice = item.price;
  }
  const summary = {
    handle,
    name: storefront.shopName || value.config.name || `@${handle}`,
    ...(storefront.tagline ? { tagline: storefront.tagline } : {}),
    ...(storefront.address ? { address: storefront.address } : {}),
    mode: storefront.mode,
    dineIn: storefront.dineIn === true,
    ...(storefront.openFrom ? { openFrom: storefront.openFrom } : {}),
    ...(storefront.lastOrder ? { lastOrder: storefront.lastOrder } : {}),
    ...(storefront.minLeadMinutes
      ? { minLeadMinutes: storefront.minLeadMinutes }
      : {}),
    menu: { itemCount: storefront.menu.length, minPrice, maxPrice },
    chains: storefront.chains ?? [storefront.chain],
    updatedAt: value.updatedAt,
  };
  state.values.set(agentShopSummaryKey(handle), JSON.stringify(summary));
  return 1;
}

async function emulateEval(script: string, keys: string[], args: string[]) {
  // CLAIM_HANDLE: 既存 KEYS/ARGV のまま record/owner index/live/agent listing を同期。
  if (script.includes("redis.call('LLEN'")) {
    if (state.values.has(keys[0])) return { ok: true as const, value: 0 };
    const ownerIndex = state.lists.get(keys[1]) ?? [];
    if (ownerIndex.length >= Number(args[2])) return { ok: true as const, value: -2 };
    const next = JSON.parse(args[0]) as HandleRecord;
    state.values.set(keys[0], args[0]);
    state.lists.set(keys[1], [args[1], ...ownerIndex]);
    state.values.delete(keys[2]);
    return { ok: true as const, value: syncAgentListing(next, args[1], true) };
  }

  const raw = state.values.get(keys[0]);
  if (raw === undefined) return { ok: true as const, value: -1 };
  let current: HandleRecord;
  try {
    current = JSON.parse(raw) as HandleRecord;
  } catch {
    return { ok: true as const, value: -2 };
  }
  if (current.owner.toLowerCase() !== args[0].toLowerCase()) {
    return { ok: true as const, value: 0 };
  }

  // RELEASE_HANDLE。
  if (script.includes("redis.call('DEL',KEYS[1]); redis.call('LREM',KEYS[2]")) {
    state.values.delete(keys[0]);
    state.lists.set(
      keys[1],
      (state.lists.get(keys[1]) ?? []).filter((entry) => entry !== args[1]),
    );
    state.values.delete(keys[2]);
    state.lists.set(
      AGENT_SHOP_INDEX_KEY,
      (state.lists.get(AGENT_SHOP_INDEX_KEY) ?? []).filter(
        (entry) => entry !== args[1],
      ),
    );
    state.values.delete(agentShopSummaryKey(args[1]));
    return { ok: true as const, value: 1 };
  }

  // CAS_UPDATE。
  if (current.updatedAt !== Number(args[1])) {
    return { ok: true as const, value: -3 };
  }
  const next = JSON.parse(args[2]) as HandleRecord;
  state.values.set(keys[0], args[2]);
  return {
    ok: true as const,
    value: syncAgentListing(
      next,
      keys[0].slice('handle:'.length),
      current.storefront?.agentListing === true,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.values.clear();
  state.lists.clear();
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvGet.mockImplementation(async (key: string) => ({
    ok: true as const,
    value: state.values.get(key) ?? null,
  }));
  kv.kvLrange.mockImplementation(async (key: string) => ({
    ok: true as const,
    value: state.lists.get(key) ?? [],
  }));
  kv.kvEval.mockImplementation(emulateEval);
});

describe('handleStore Shops API agent index/summary Lua', () => {
  const base = {
    handle: 'alice',
    owner: OWNER,
    config: CONFIG,
    nowMs: 11,
  };

  it('opt-in update は同一 EVAL で index 一意追加 + 全検索 summary を原子 materialize', async () => {
    saveRecord('alice', record());
    const result = await reserveOrUpdateHandle({
      ...base,
      storefront: LISTED_STORE,
      expectedUpdatedAt: 10,
    });
    expect(result.status).toBe('updated');
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual(['alice']);
    expect(JSON.parse(state.values.get(agentShopSummaryKey('alice')) ?? '{}')).toEqual({
      handle: 'alice',
      name: '掲載珈琲店',
      tagline: '焼きたてと淹れたて',
      address: '東京都千代田区1-2-3',
      mode: 'storefront',
      dineIn: true,
      openFrom: '09:30',
      lastOrder: '21:30',
      minLeadMinutes: 20,
      menu: {
        itemCount: 3,
        minPrice: '9.5',
        maxPrice: '1200.000000000000000001',
      },
      chains: ['polygon', 'kaia'],
      updatedAt: 11,
    });
    expect(kv.kvEval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = kv.kvEval.mock.calls[0];
    expect(keys).toEqual(['handle:alice']);
    expect(args).toHaveLength(3);
    expect(script).toContain(AGENT_SHOP_INDEX_KEY);
    expect(script).toContain("menu={itemCount=#sf.menu,minPrice=minp,maxPrice=maxp}");
  });

  it('opt-in の再更新は index を重複させず summary timestamp を更新', async () => {
    saveRecord('alice', record({ storefront: LISTED_STORE }));
    state.lists.set(AGENT_SHOP_INDEX_KEY, ['alice', 'alice']);
    const result = await reserveOrUpdateHandle({
      ...base,
      storefront: LISTED_STORE,
      expectedUpdatedAt: 10,
    });
    expect(result.status).toBe('updated');
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual(['alice']);
    expect(JSON.parse(state.values.get(agentShopSummaryKey('alice')) ?? '{}').updatedAt).toBe(11);
  });

  it('opt-out update は index 全重複 + summary を同じ EVAL で削除', async () => {
    saveRecord('alice', record({ storefront: LISTED_STORE }));
    state.lists.set(AGENT_SHOP_INDEX_KEY, ['bob', 'alice', 'alice']);
    state.values.set(agentShopSummaryKey('alice'), '{"stale":true}');
    const result = await reserveOrUpdateHandle({
      ...base,
      storefront: UNLISTED_STORE,
      expectedUpdatedAt: 10,
    });
    expect(result.status).toBe('updated');
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual(['bob']);
    expect(state.values.has(agentShopSummaryKey('alice'))).toBe(false);
  });

  it('[漏れ経路1] EVAL 失敗は publish を kv_error にし、record/index/summary の偽成功を作らない', async () => {
    const original = record();
    saveRecord('alice', original);
    kv.kvEval.mockResolvedValueOnce({ ok: false });
    const result = await reserveOrUpdateHandle({
      ...base,
      storefront: LISTED_STORE,
      expectedUpdatedAt: 10,
    });
    expect(result.status).toBe('kv_error');
    expect(JSON.parse(state.values.get('handle:alice') ?? '{}')).toEqual(original);
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toBeUndefined();
    expect(state.values.has(agentShopSummaryKey('alice'))).toBe(false);
  });

  it('[漏れ経路2] 同一 baseline の opt-in/opt-out 並行更新は CAS 勝者と掲載状態が一致', async () => {
    saveRecord('alice', record());
    const [listed, unlisted] = await Promise.all([
      reserveOrUpdateHandle({
        ...base,
        storefront: LISTED_STORE,
        expectedUpdatedAt: 10,
      }),
      reserveOrUpdateHandle({
        ...base,
        storefront: UNLISTED_STORE,
        expectedUpdatedAt: 10,
      }),
    ]);
    expect([listed.status, unlisted.status].sort()).toEqual(['conflict', 'updated']);
    const stored = JSON.parse(state.values.get('handle:alice') ?? '{}') as HandleRecord;
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)?.includes('alice')).toBe(
      stored.storefront?.agentListing === true,
    );
    expect(state.values.has(agentShopSummaryKey('alice'))).toBe(
      stored.storefront?.agentListing === true,
    );
  });

  it('[漏れ経路3] 500件満杯は publish 本体だけ成功 + index_full、既存店を LTRIM で落とさない', async () => {
    saveRecord('alice', record());
    const fullIndex = Array.from({ length: AGENT_SHOP_INDEX_MAX }, (_, i) => `shop-${i}`);
    state.lists.set(AGENT_SHOP_INDEX_KEY, fullIndex);
    state.values.set(agentShopSummaryKey('shop-0'), '{"keep":true}');
    const result = await reserveOrUpdateHandle({
      ...base,
      storefront: LISTED_STORE,
      expectedUpdatedAt: 10,
    });
    expect(result).toMatchObject({ status: 'updated', listing: 'index_full' });
    expect(
      (JSON.parse(state.values.get('handle:alice') ?? '{}') as HandleRecord).storefront
        ?.agentListing,
    ).toBe(true);
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual(fullIndex);
    expect(state.values.get(agentShopSummaryKey('shop-0'))).toBe('{"keep":true}');
    expect(state.values.has(agentShopSummaryKey('alice'))).toBe(false);
    expect(kv.kvEval.mock.calls[0][0]).not.toContain('LTRIM');
  });

  it('[漏れ経路4] storefront:null 取り下げは index + summary を削除', async () => {
    saveRecord('alice', record({ storefront: LISTED_STORE }));
    state.lists.set(AGENT_SHOP_INDEX_KEY, ['alice']);
    state.values.set(agentShopSummaryKey('alice'), '{"listed":true}');
    const result = await reserveOrUpdateHandle({
      ...base,
      storefront: null,
      expectedUpdatedAt: 10,
    });
    expect(result.status).toBe('updated');
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual([]);
    expect(state.values.has(agentShopSummaryKey('alice'))).toBe(false);
  });

  it('[漏れ経路5] RELEASE は handle/owner/live と index/summary を一括削除', async () => {
    saveRecord('alice', record({ storefront: LISTED_STORE }));
    state.lists.set(`wallet:handles:${OWNER.toLowerCase()}`, ['alice']);
    state.lists.set(AGENT_SHOP_INDEX_KEY, ['alice']);
    state.values.set(agentShopSummaryKey('alice'), '{"listed":true}');
    state.values.set('shop:live:alice', '{"paused":true}');
    expect(await releaseHandle({ handle: 'alice', owner: OWNER })).toBe('released');
    expect(state.values.has('handle:alice')).toBe(false);
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual([]);
    expect(state.values.has(agentShopSummaryKey('alice'))).toBe(false);
  });

  it('[漏れ経路6] 解放後の handle 再取得は旧 owner の stale index/summary を cleanup', async () => {
    state.lists.set(AGENT_SHOP_INDEX_KEY, ['alice']);
    state.values.set(agentShopSummaryKey('alice'), '{"oldOwner":true}');
    const result = await reserveOrUpdateHandle(base);
    expect(result.status).toBe('created');
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual([]);
    expect(state.values.has(agentShopSummaryKey('alice'))).toBe(false);
  });

  it('[漏れ経路7] profile-only POST は既存 opt-in を保持し、新 config で summary を更新', async () => {
    const listedWithoutOwnName: StorefrontParts = {
      ...LISTED_STORE,
      shopName: undefined,
    };
    saveRecord('alice', record({ storefront: listedWithoutOwnName }));
    state.lists.set(AGENT_SHOP_INDEX_KEY, ['alice']);
    state.values.set(agentShopSummaryKey('alice'), '{"name":"古い店名"}');
    const result = await reserveOrUpdateHandle({
      ...base,
      config: { ...CONFIG, name: '更新後の店名' },
      profile: { bio: 'profile-only update' },
      expectedUpdatedAt: 10,
    });
    expect(result.status).toBe('updated');
    expect(result.record?.storefront?.agentListing).toBe(true);
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual(['alice']);
    expect(JSON.parse(state.values.get(agentShopSummaryKey('alice')) ?? '{}').name).toBe(
      '更新後の店名',
    );
  });

  it('[漏れ経路8] 新規 claim の direct opt-in も同じ Lua で index + summary を作成', async () => {
    const result = await reserveOrUpdateHandle({ ...base, storefront: LISTED_STORE });
    expect(result.status).toBe('created');
    expect(state.lists.get(AGENT_SHOP_INDEX_KEY)).toEqual(['alice']);
    expect(JSON.parse(state.values.get(agentShopSummaryKey('alice')) ?? '{}')).toMatchObject({
      handle: 'alice',
      name: '掲載珈琲店',
      updatedAt: 11,
    });
    expect(kv.kvEval.mock.calls[0][1]).toEqual([
      'handle:alice',
      `wallet:handles:${OWNER.toLowerCase()}`,
      'shop:live:alice',
    ]);
    expect(kv.kvEval.mock.calls[0][2]).toHaveLength(3);
  });
});
