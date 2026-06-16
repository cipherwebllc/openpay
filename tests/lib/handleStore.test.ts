import { describe, it, expect, vi, beforeEach } from 'vitest';

// KV を完全モックして handleStore の分岐 (null-on-error / atomic LPUSH+rollback / LREM 解放 /
// 上限 / owner ゲート) を検証する。
const kv = vi.hoisted(() => ({
  isKvConfigured: vi.fn(() => true),
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  kvDel: vi.fn(),
  kvLpush: vi.fn(),
  kvLrange: vi.fn(),
  kvLrem: vi.fn(),
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
import type { HandleTipConfig } from '@/lib/handle';
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
const recJson = (owner: string, createdAt = 1) =>
  JSON.stringify({
    owner,
    config: CONFIG,
    createdAt,
    updatedAt: createdAt,
  });

beforeEach(() => {
  vi.clearAllMocks();
  kv.isKvConfigured.mockReturnValue(true);
  kv.kvGet.mockResolvedValue({ ok: true, value: null });
  kv.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
  kv.kvDel.mockResolvedValue({ ok: true, value: 1 });
  kv.kvLpush.mockResolvedValue({ ok: true, value: 1 });
  kv.kvLrange.mockResolvedValue({ ok: true, value: [] });
  kv.kvLrem.mockResolvedValue({ ok: true, value: 1 });
  kv.kvEval.mockResolvedValue({ ok: true, value: 1 }); // CAS: 既定は成功 (1)
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
    kv.kvGet.mockResolvedValue({ ok: true, value: recJson(OTHER) });
    expect((await reserveOrUpdateHandle(base)).status).toBe('taken');
  });

  it('既存 & 同 owner → CAS で updated (createdAt 保持・nx claim は使わない)', async () => {
    kv.kvGet.mockResolvedValue({ ok: true, value: recJson(OWNER, 42) });
    const res = await reserveOrUpdateHandle(base);
    expect(res.status).toBe('updated');
    expect(res.record?.createdAt).toBe(42);
    expect(kv.kvEval).toHaveBeenCalled(); // owner-conditional CAS で置換
    expect(kv.kvSet).not.toHaveBeenCalled(); // nx claim は新規のみ
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
    kv.kvGet.mockResolvedValue({ ok: true, value: existing });
    // base.config は message/webhook を持たない (builder が送らない) → 既存値を保持。
    const res = await reserveOrUpdateHandle(base);
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
    kv.kvGet.mockResolvedValue({ ok: true, value: existing });
    const res = await reserveOrUpdateHandle(base); // base に profile 無し (undefined)
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
    kv.kvGet.mockResolvedValue({ ok: true, value: existing });
    const res = await reserveOrUpdateHandle({ ...base, profile: {} });
    expect(res.status).toBe('updated');
    expect(res.record?.profile).toBeUndefined();
  });

  it('既存 & 同 owner だが CAS で owner 変化 (value!=1) → taken', async () => {
    kv.kvGet.mockResolvedValue({ ok: true, value: recJson(OWNER, 42) });
    kv.kvEval.mockResolvedValue({ ok: true, value: 0 });
    expect((await reserveOrUpdateHandle(base)).status).toBe('taken');
  });

  it('新規だが所有 index 読み取りエラー → kv_error (claim しない)', async () => {
    kv.kvGet.mockResolvedValue({ ok: true, value: null });
    kv.kvLrange.mockResolvedValue({ ok: false });
    const res = await reserveOrUpdateHandle(base);
    expect(res.status).toBe('kv_error');
    expect(kv.kvSet).not.toHaveBeenCalled(); // nx claim へ進まない
  });

  it('上限到達 → limit', async () => {
    kv.kvLrange.mockResolvedValue({ ok: true, value: ['a', 'b', 'c'] });
    expect((await reserveOrUpdateHandle(base)).status).toBe('limit');
  });

  it('新規成功 → created (nx claim + LPUSH)', async () => {
    const res = await reserveOrUpdateHandle(base);
    expect(res.status).toBe('created');
    expect(kv.kvSet).toHaveBeenCalledWith(expect.any(String), expect.any(String), { nx: true });
    expect(kv.kvLpush).toHaveBeenCalledWith('wallet:handles:' + OWNER.toLowerCase(), 'alice');
  });

  it('nx 競合負け (value !== OK) → taken', async () => {
    kv.kvSet.mockResolvedValue({ ok: true, value: null });
    expect((await reserveOrUpdateHandle(base)).status).toBe('taken');
  });

  it('LPUSH 失敗 → claim rollback (kvDel) + index も LREM で掃除 + kv_error', async () => {
    kv.kvLpush.mockResolvedValue({ ok: false });
    const res = await reserveOrUpdateHandle(base);
    expect(res.status).toBe('kv_error');
    expect(kv.kvDel).toHaveBeenCalledWith('handle:alice');
    // timeout-after-success に備え index からも除去 (stale entry 防止)。
    expect(kv.kvLrem).toHaveBeenCalledWith(
      'wallet:handles:' + OWNER.toLowerCase(),
      'alice',
    );
  });

  it('profile 付きで created → record に profile を含み serialize される', async () => {
    const profile = { bio: 'hi', links: [{ label: 'X', url: 'https://x.com/a' }] };
    const res = await reserveOrUpdateHandle({ ...base, profile });
    expect(res.status).toBe('created');
    expect(res.record?.profile).toEqual(profile);
    const stored = JSON.parse(kv.kvSet.mock.calls[0][1] as string);
    expect(stored.profile).toEqual(profile);
  });

  it('空 profile ({}) は record に持たせない', async () => {
    const res = await reserveOrUpdateHandle({ ...base, profile: {} });
    expect(res.status).toBe('created');
    expect(res.record?.profile).toBeUndefined();
    const stored = JSON.parse(kv.kvSet.mock.calls[0][1] as string);
    expect(stored.profile).toBeUndefined();
  });

  it('storefront 付きで created → record に含み serialize される', async () => {
    const res = await reserveOrUpdateHandle({ ...base, storefront: STORE });
    expect(res.status).toBe('created');
    expect(res.record?.storefront).toEqual(STORE);
    const stored = JSON.parse(kv.kvSet.mock.calls[0][1] as string);
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
    kv.kvGet.mockResolvedValue({ ok: true, value: existing });
    const res = await reserveOrUpdateHandle(base); // base に storefront 無し (undefined)
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
    kv.kvGet.mockResolvedValue({ ok: true, value: existing });
    const res = await reserveOrUpdateHandle({ ...base, storefront: null });
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
    kv.kvGet.mockResolvedValue({ ok: true, value: existing });
    const next: StorefrontParts = { ...STORE, chain: 'kaia' };
    const res = await reserveOrUpdateHandle({ ...base, storefront: next });
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

describe('releaseHandle (owner-conditional CAS)', () => {
  const base = { handle: 'alice', owner: OWNER };

  it('CAS -1 (未存在) → not_found', async () => {
    kv.kvEval.mockResolvedValue({ ok: true, value: -1 });
    expect(await releaseHandle(base)).toBe('not_found');
  });
  it('CAS 0 (別 owner) → forbidden', async () => {
    kv.kvEval.mockResolvedValue({ ok: true, value: 0 });
    expect(await releaseHandle(base)).toBe('forbidden');
  });
  it('CAS 1 → released (kvEval + LREM)', async () => {
    kv.kvEval.mockResolvedValue({ ok: true, value: 1 });
    expect(await releaseHandle(base)).toBe('released');
    expect(kv.kvEval).toHaveBeenCalled();
    expect(kv.kvLrem).toHaveBeenCalledWith(
      'wallet:handles:' + OWNER.toLowerCase(),
      'alice',
    );
  });
  it('CAS の KV エラー → kv_error', async () => {
    kv.kvEval.mockResolvedValue({ ok: false });
    expect(await releaseHandle(base)).toBe('kv_error');
  });
  it('LREM 失敗でも released (handle は解放済み・index は best-effort)', async () => {
    kv.kvEval.mockResolvedValue({ ok: true, value: 1 });
    kv.kvLrem.mockResolvedValue({ ok: false });
    expect(await releaseHandle(base)).toBe('released');
  });
});
