import { describe, it, expect, vi, beforeEach } from 'vitest';

// handleStore が渡す Lua を共有 in-memory KV 上で実行し、claim/release の複数 key 更新を
// canned result ではなく EVAL の原子操作として検証する (x402/registry.test.ts と同型)。
const store = vi.hoisted(() => ({
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
  resolveHandle,
  listHandlesForOwner,
  listHandleRecordsForOwner,
  reserveOrUpdateHandle,
  releaseHandle,
} from '@/lib/handleStore';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';
import type { StorefrontParts } from '@/lib/mobileOrder';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const CONFIG: HandleTipConfig = {
  to: OWNER,
  methods: [{ token: 'jpyc', chain: 'polygon' }],
};
const STORE: StorefrontParts = {
  chain: 'polygon',
  mode: 'storefront',
  feePayer: 'merchant',
  menu: [{ id: 'a', name: 'ブレンド', price: '500' }],
};
const recJson = (owner: string, createdAt = 1, updatedAt = createdAt) =>
  JSON.stringify({
    owner,
    config: CONFIG,
    createdAt,
    updatedAt,
  });

async function emulateEval(script: string, keys: string[], args: string[]) {
  // CLAIM_HANDLE: GET → LLEN cap → SET + LPUSH + DEL shop:live。
  if (script.includes("redis.call('LLEN'")) {
    if (store.values.has(keys[0])) return { ok: true as const, value: 0 };
    const index = store.lists.get(keys[1]) ?? [];
    if (index.length >= Number(args[2])) return { ok: true as const, value: -2 };
    store.values.set(keys[0], args[0]);
    index.unshift(args[1]);
    store.lists.set(keys[1], index);
    store.values.delete(keys[2]);
    return { ok: true as const, value: 1 };
  }

  const raw = store.values.get(keys[0]);
  if (raw === undefined) return { ok: true as const, value: -1 };
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: true as const, value: -2 };
  }
  if (typeof record.owner !== 'string') return { ok: true as const, value: -2 };
  if (record.owner.toLowerCase() !== args[0].toLowerCase()) {
    return { ok: true as const, value: 0 };
  }

  // RELEASE_HANDLE: owner 一致時に handle/index/shop:live を同時削除。
  if (script.includes("redis.call('LREM'")) {
    store.values.delete(keys[0]);
    const index = store.lists.get(keys[1]) ?? [];
    store.lists.set(
      keys[1],
      index.filter((value) => value !== args[1]),
    );
    store.values.delete(keys[2]);
    return { ok: true as const, value: 1 };
  }

  // CAS_UPDATE: owner と updatedAt の baseline が一致するときだけ record を置換。
  if (typeof record.updatedAt !== 'number' || record.updatedAt !== Number(args[1])) {
    return { ok: true as const, value: -3 };
  }
  store.values.set(keys[0], args[2]);
  return { ok: true as const, value: 1 };
}

function setExisting(raw: string, handle = 'alice') {
  store.values.set(`handle:${handle}`, raw);
  kv.kvGet.mockResolvedValue({ ok: true, value: raw });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.values.clear();
  store.lists.clear();
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvGet.mockImplementation(async (key: string) => ({
    ok: true as const,
    value: store.values.get(key) ?? null,
  }));
  kv.kvLrange.mockImplementation(async (key: string, start: number, stop: number) => {
    const list = store.lists.get(key) ?? [];
    const end = stop < 0 ? list.length : stop + 1;
    return { ok: true as const, value: list.slice(start, end) };
  });
  kv.kvEval.mockImplementation(emulateEval);
});

describe('listHandlesForOwner', () => {
  it('KV エラーは null を返す (空 [] と区別)', async () => {
    kv.kvLrange.mockResolvedValue({ ok: false });
    expect(await listHandlesForOwner(OWNER)).toBeNull();
  });
  it('空リストは [] (ok)・重複は dedup', async () => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: [] });
    expect(await listHandlesForOwner(OWNER)).toEqual([]);
    kv.kvLrange.mockResolvedValue({ ok: true, value: ['a', 'a', 'b'] });
    expect(await listHandlesForOwner(OWNER)).toEqual(['a', 'b']);
  });
  it('KV 未設定は null', async () => {
    kv.isKvConfigured.mockReturnValue(false);
    expect(await listHandlesForOwner(OWNER)).toBeNull();
  });
});

describe('resolveHandle', () => {
  it('ok + 正レコード → {ok:true, record}', async () => {
    kv.kvGet.mockResolvedValue({ ok: true, value: recJson(OWNER) });
    const r = await resolveHandle('alice');
    expect(r.ok && r.record?.owner).toBe(OWNER);
  });
  it('未存在 → {ok:true, record:null}', async () => {
    kv.kvGet.mockResolvedValue({ ok: true, value: null });
    expect(await resolveHandle('alice')).toEqual({ ok: true, record: null });
  });
  it('KV エラーは {ok:false} (未存在と区別)', async () => {
    kv.kvGet.mockResolvedValue({ ok: false });
    expect(await resolveHandle('alice')).toEqual({ ok: false });
  });
});

describe('reserveOrUpdateHandle', () => {
  const base = { handle: 'alice', owner: OWNER, config: CONFIG, nowMs: 100 };

  it('KV 未設定 → kv_unavailable', async () => {
    kv.isKvConfigured.mockReturnValue(false);
    expect((await reserveOrUpdateHandle(base)).status).toBe('kv_unavailable');
  });

  it('既存 & 別 owner → taken', async () => {
    setExisting(recJson(OTHER));
    expect((await reserveOrUpdateHandle(base)).status).toBe('taken');
  });

  it('既存 & 同 owner → CAS で updated (createdAt 保持・claim Lua は使わない)', async () => {
    setExisting(recJson(OWNER, 42));
    const res = await reserveOrUpdateHandle({ ...base, expectedUpdatedAt: 42 });
    expect(res.status).toBe('updated');
    expect(res.record?.createdAt).toBe(42);
    expect(kv.kvEval.mock.calls[0][2][1]).toBe('42');
    expect(kv.kvEval.mock.calls[0][0]).not.toContain("redis.call('LLEN'");
  });

  it('update の updatedAt は既存値より必ず単調増加して serialize される', async () => {
    setExisting(recJson(OWNER, 42, 100));
    const res = await reserveOrUpdateHandle({
      ...base,
      nowMs: 99,
      expectedUpdatedAt: 100,
    });
    expect(res.status).toBe('updated');
    expect(res.record?.updatedAt).toBe(101);
    const stored = JSON.parse(kv.kvEval.mock.calls[0][2][2] as string);
    expect(stored.updatedAt).toBe(101);
  });

  it('既存 & 同 owner でも expectedUpdatedAt 欠落/不一致 → conflict (CAS 不発)', async () => {
    setExisting(recJson(OWNER, 42, 50));
    expect((await reserveOrUpdateHandle(base)).status).toBe('conflict');
    expect(
      (await reserveOrUpdateHandle({ ...base, expectedUpdatedAt: 49 })).status,
    ).toBe('conflict');
    expect(kv.kvEval).not.toHaveBeenCalled();
  });

  it('読込後に別更新が勝ち CAS -3 → conflict', async () => {
    setExisting(recJson(OWNER, 42, 50));
    kv.kvEval.mockResolvedValue({ ok: true, value: -3 });
    expect(
      (await reserveOrUpdateHandle({ ...base, expectedUpdatedAt: 50 })).status,
    ).toBe('conflict');
  });

  it('update は builder 非管理の tip メタ (message/webhook) を既存から保持', async () => {
    const existing = JSON.stringify({
      owner: OWNER,
      config: {
        to: OWNER,
        methods: [{ token: 'jpyc', chain: 'polygon' }],
        message: 'thx',
        webhook: 'https://hook.example',
      },
      createdAt: 5,
      updatedAt: 5,
    });
    setExisting(existing);
    // base.config は message/webhook を持たない (builder が送らない) → 既存値を保持。
    const res = await reserveOrUpdateHandle({ ...base, expectedUpdatedAt: 5 });
    expect(res.status).toBe('updated');
    expect(res.record?.config.message).toBe('thx');
    expect(res.record?.config.webhook).toBe('https://hook.example');
  });

  it('update で profile 省略 → 既存 profile を保持 (config-only update が消さない)', async () => {
    const existing = JSON.stringify({
      owner: OWNER,
      config: CONFIG,
      profile: { bio: 'keep me' },
      createdAt: 5,
      updatedAt: 5,
    });
    setExisting(existing);
    const res = await reserveOrUpdateHandle({
      ...base,
      expectedUpdatedAt: 5,
    }); // base に profile 無し (undefined)
    expect(res.status).toBe('updated');
    expect(res.record?.profile).toEqual({ bio: 'keep me' });
  });

  it('update で profile:{} 明示 → クリア', async () => {
    const existing = JSON.stringify({
      owner: OWNER,
      config: CONFIG,
      profile: { bio: 'x' },
      createdAt: 5,
      updatedAt: 5,
    });
    setExisting(existing);
    const res = await reserveOrUpdateHandle({
      ...base,
      profile: {},
      expectedUpdatedAt: 5,
    });
    expect(res.status).toBe('updated');
    expect(res.record?.profile).toBeUndefined();
  });

  it('既存 & 同 owner だが CAS で owner 変化 (value!=1) → taken', async () => {
    setExisting(recJson(OWNER, 42));
    kv.kvEval.mockResolvedValue({ ok: true, value: 0 });
    expect(
      (await reserveOrUpdateHandle({ ...base, expectedUpdatedAt: 42 })).status,
    ).toBe('taken');
  });

  it('claim EVAL 失敗 → kv_error (偽成功せず rollback も行わない)', async () => {
    kv.kvEval.mockResolvedValue({ ok: false });
    const res = await reserveOrUpdateHandle(base);
    expect(res.status).toBe('kv_error');
    expect(store.values.has('handle:alice')).toBe(false);
    expect(store.lists.get('wallet:handles:' + OWNER.toLowerCase())).toBeUndefined();
  });

  it('claim Lua: raw LLEN が上限到達 → limit', async () => {
    store.lists.set('wallet:handles:' + OWNER.toLowerCase(), ['a', 'b', 'c']);
    expect((await reserveOrUpdateHandle(base)).status).toBe('limit');
    expect(store.values.has('handle:alice')).toBe(false);
  });

  it('claim Lua: 新規成功 → handle 保存 + owner index LPUSH', async () => {
    const res = await reserveOrUpdateHandle(base);
    expect(res.status).toBe('created');
    const [, keys, args] = kv.kvEval.mock.calls[0];
    expect(keys).toEqual([
      'handle:alice',
      'wallet:handles:' + OWNER.toLowerCase(),
      'shop:live:alice',
    ]);
    expect(args.slice(1)).toEqual(['alice', '3']);
    expect(JSON.parse(store.values.get('handle:alice') ?? '{}').owner).toBe(OWNER);
    expect(store.lists.get('wallet:handles:' + OWNER.toLowerCase())).toEqual(['alice']);
  });

  it('claim Lua: 初回 GET 後に別 claim が確保 → taken', async () => {
    store.values.set('handle:alice', recJson(OTHER));
    kv.kvGet.mockResolvedValueOnce({ ok: true, value: null });
    expect((await reserveOrUpdateHandle(base)).status).toBe('taken');
    expect(JSON.parse(store.values.get('handle:alice') ?? '{}').owner).toBe(OTHER);
  });

  it('同一 owner の同時 claim が上限 3 を超えない', async () => {
    const results = await Promise.all(
      ['alice', 'bob', 'carol', 'dave'].map((handle) =>
        reserveOrUpdateHandle({ ...base, handle }),
      ),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'limit')).toHaveLength(1);
    expect(store.lists.get('wallet:handles:' + OWNER.toLowerCase())).toHaveLength(3);
  });

  it('claim 成功時に旧 owner の shop:live を削除', async () => {
    store.values.set(
      'shop:live:alice',
      JSON.stringify({ soldOut: ['a'], paused: true, updatedAt: 10 }),
    );
    expect((await reserveOrUpdateHandle(base)).status).toBe('created');
    expect(store.values.has('shop:live:alice')).toBe(false);
  });

  it('profile 付きで created → record に profile を含み serialize される', async () => {
    const profile = { bio: 'hi', links: [{ label: 'X', url: 'https://x.com/a' }] };
    const res = await reserveOrUpdateHandle({ ...base, profile });
    expect(res.status).toBe('created');
    expect(res.record?.profile).toEqual(profile);
    const stored = JSON.parse(store.values.get('handle:alice') ?? '{}');
    expect(stored.profile).toEqual(profile);
  });

  it('検証済み heading profile を created/update ともそのまま serialize する', async () => {
    const createdProfile: HandleProfile = {
      links: [
        { kind: 'heading', label: 'Projects', emoji: '📌' },
        { label: 'X', url: 'https://x.com/a', featured: true },
      ],
    };
    const created = await reserveOrUpdateHandle({
      ...base,
      profile: createdProfile,
    });
    expect(created.status).toBe('created');
    expect(created.record?.profile).toEqual(createdProfile);
    expect(
      JSON.parse(store.values.get('handle:alice') ?? '{}').profile,
    ).toEqual(createdProfile);

    const updatedProfile: HandleProfile = {
      links: [{ kind: 'heading', label: 'Selected projects' }],
    };
    const updated = await reserveOrUpdateHandle({
      ...base,
      profile: updatedProfile,
      expectedUpdatedAt: 100,
      nowMs: 101,
    });
    expect(updated.status).toBe('updated');
    expect(updated.record?.profile).toEqual(updatedProfile);
    expect(
      JSON.parse(store.values.get('handle:alice') ?? '{}').profile,
    ).toEqual(updatedProfile);
  });

  it('空 profile ({}) は record に持たせない', async () => {
    const res = await reserveOrUpdateHandle({ ...base, profile: {} });
    expect(res.status).toBe('created');
    expect(res.record?.profile).toBeUndefined();
    const stored = JSON.parse(store.values.get('handle:alice') ?? '{}');
    expect(stored.profile).toBeUndefined();
  });

  it('storefront 付きで created → record に含み serialize される', async () => {
    const res = await reserveOrUpdateHandle({ ...base, storefront: STORE });
    expect(res.status).toBe('created');
    expect(res.record?.storefront).toEqual(STORE);
    const stored = JSON.parse(store.values.get('handle:alice') ?? '{}');
    expect(stored.storefront).toEqual(STORE);
  });

  it('update で storefront 省略 → 既存 storefront を保持 (config-only update が消さない)', async () => {
    const existing = JSON.stringify({
      owner: OWNER,
      config: CONFIG,
      storefront: STORE,
      createdAt: 5,
      updatedAt: 5,
    });
    setExisting(existing);
    const res = await reserveOrUpdateHandle({
      ...base,
      expectedUpdatedAt: 5,
    }); // base に storefront 無し (undefined)
    expect(res.status).toBe('updated');
    expect(res.record?.storefront).toEqual(STORE);
  });

  it('update で storefront:null 明示 → クリア (店舗取り下げ)', async () => {
    const existing = JSON.stringify({
      owner: OWNER,
      config: CONFIG,
      storefront: STORE,
      createdAt: 5,
      updatedAt: 5,
    });
    setExisting(existing);
    const res = await reserveOrUpdateHandle({
      ...base,
      storefront: null,
      expectedUpdatedAt: 5,
    });
    expect(res.status).toBe('updated');
    expect(res.record?.storefront).toBeUndefined();
  });

  it('update で storefront object → 置換', async () => {
    const existing = JSON.stringify({
      owner: OWNER,
      config: CONFIG,
      storefront: STORE,
      createdAt: 5,
      updatedAt: 5,
    });
    setExisting(existing);
    const next: StorefrontParts = { ...STORE, chain: 'kaia' };
    const res = await reserveOrUpdateHandle({
      ...base,
      storefront: next,
      expectedUpdatedAt: 5,
    });
    expect(res.record?.storefront).toEqual(next);
  });
});

describe('listHandleRecordsForOwner', () => {
  it('名前一覧 → 各 record を取得して {handle, record}[] を返す', async () => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: ['alice', 'bob'] });
    kv.kvGet
      .mockResolvedValueOnce({ ok: true, value: recJson(OWNER, 1) }) // alice
      .mockResolvedValueOnce({ ok: true, value: recJson(OWNER, 2) }); // bob
    const res = await listHandleRecordsForOwner(OWNER);
    expect(res?.map((o) => o.handle)).toEqual(['alice', 'bob']);
    expect(res?.[0].record.config.methods[0].token).toBe('jpyc');
  });
  it('record 取得が KV エラー → null (空と区別)', async () => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: ['alice'] });
    kv.kvGet.mockResolvedValue({ ok: false });
    expect(await listHandleRecordsForOwner(OWNER)).toBeNull();
  });
  it('名前一覧が null (KV エラー) → null', async () => {
    kv.kvLrange.mockResolvedValue({ ok: false });
    expect(await listHandleRecordsForOwner(OWNER)).toBeNull();
  });
  it('index に名前はあるが record 消失 → 黙ってスキップ', async () => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: ['ghost'] });
    kv.kvGet.mockResolvedValue({ ok: true, value: null });
    expect(await listHandleRecordsForOwner(OWNER)).toEqual([]);
  });
  it('stale index が別 owner の record を指す → スキップ (他人の handle を返さない)', async () => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: ['taken'] });
    kv.kvGet.mockResolvedValue({ ok: true, value: recJson(OTHER) }); // 別 owner
    expect(await listHandleRecordsForOwner(OWNER)).toEqual([]);
  });
});

describe('releaseHandle (owner-conditional atomic cleanup)', () => {
  const base = { handle: 'alice', owner: OWNER };

  it('release Lua: handle 未存在 → not_found', async () => {
    expect(await releaseHandle(base)).toBe('not_found');
  });

  it('release Lua: owner 不一致 → forbidden、どの key も変更しない', async () => {
    store.values.set('handle:alice', recJson(OTHER));
    store.lists.set('wallet:handles:' + OWNER.toLowerCase(), ['alice']);
    store.values.set('shop:live:alice', '{"paused":true}');
    expect(await releaseHandle(base)).toBe('forbidden');
    expect(store.values.has('handle:alice')).toBe(true);
    expect(store.lists.get('wallet:handles:' + OWNER.toLowerCase())).toEqual(['alice']);
    expect(store.values.has('shop:live:alice')).toBe(true);
  });

  it('release Lua: handle・owner index 全重複・shop:live をまとめて削除', async () => {
    store.values.set('handle:alice', recJson(OWNER));
    store.lists.set('wallet:handles:' + OWNER.toLowerCase(), [
      'bob',
      'alice',
      'alice',
    ]);
    store.values.set('shop:live:alice', '{"paused":true}');
    expect(await releaseHandle(base)).toBe('released');
    expect(kv.kvEval.mock.calls[0][1]).toEqual([
      'handle:alice',
      'wallet:handles:' + OWNER.toLowerCase(),
      'shop:live:alice',
    ]);
    expect(kv.kvEval.mock.calls[0][2]).toEqual([OWNER, 'alice']);
    expect(store.values.has('handle:alice')).toBe(false);
    expect(store.lists.get('wallet:handles:' + OWNER.toLowerCase())).toEqual([
      'bob',
    ]);
    expect(store.values.has('shop:live:alice')).toBe(false);
  });

  it('release Lua: malformed record → not_found (現行戻り値体系)', async () => {
    store.values.set('handle:alice', '{}');
    expect(await releaseHandle(base)).toBe('not_found');
    expect(store.values.has('handle:alice')).toBe(true);
  });

  it('release EVAL の KV エラー → kv_error・偽成功しない', async () => {
    store.values.set('handle:alice', recJson(OWNER));
    store.lists.set('wallet:handles:' + OWNER.toLowerCase(), ['alice']);
    store.values.set('shop:live:alice', '{"paused":true}');
    kv.kvEval.mockResolvedValue({ ok: false });
    expect(await releaseHandle(base)).toBe('kv_error');
    expect(store.values.has('handle:alice')).toBe(true);
    expect(store.lists.get('wallet:handles:' + OWNER.toLowerCase())).toEqual([
      'alice',
    ]);
    expect(store.values.has('shop:live:alice')).toBe(true);
  });
});
