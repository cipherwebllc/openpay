import { describe, it, expect, vi, beforeEach } from 'vitest';

// KV 境界のみ mock。_store の冪等 claim 状態機械 / JSON 直列化を本物のまま実行する。
const kv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  getdel: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  kvGet: (...a: unknown[]) => kv.get(...a),
  kvSet: (...a: unknown[]) => kv.set(...a),
  kvDel: (...a: unknown[]) => kv.del(...a),
  kvGetDel: (...a: unknown[]) => kv.getdel(...a),
}));

import {
  claimSync,
  finalizeSync,
  releaseSync,
  getToken,
  setToken,
  setState,
  consumeState,
} from '@/app/api/freee/_store';
import type { StoredToken } from '@/lib/freee';

const KEY = 'freee:synced:0xabc:0xtx';

beforeEach(() => {
  kv.get.mockReset();
  kv.set.mockReset();
  kv.del.mockReset();
  kv.getdel.mockReset();
});

describe('claimSync (SET NX 冪等状態機械)', () => {
  it('fresh: NX 取得成功 → pending を TTL 付きで claim', async () => {
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    expect(await claimSync(KEY)).toEqual({ kind: 'fresh' });
    expect(kv.set).toHaveBeenCalledWith(KEY, 'pending', { nx: true, ttlSec: 300 });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('done: NX 衝突 + 既存値が数値 → 既存 dealId を返す', async () => {
    kv.set.mockResolvedValue({ ok: true, value: null });
    kv.get.mockResolvedValue({ ok: true, value: '9001' });
    expect(await claimSync(KEY)).toEqual({ kind: 'done', dealId: 9001 });
  });

  it('in-flight: NX 衝突 + 既存値が pending', async () => {
    kv.set.mockResolvedValue({ ok: true, value: null });
    kv.get.mockResolvedValue({ ok: true, value: 'pending' });
    expect(await claimSync(KEY)).toEqual({ kind: 'in-flight' });
  });

  it('in-flight: NX 衝突 + 既存値が非数値 (異常値) でも安全に in-flight 扱い', async () => {
    kv.set.mockResolvedValue({ ok: true, value: null });
    kv.get.mockResolvedValue({ ok: true, value: 'garbage' });
    expect(await claimSync(KEY)).toEqual({ kind: 'in-flight' });
  });

  it('in-flight: NX 衝突 + 既存値 read 失敗', async () => {
    kv.set.mockResolvedValue({ ok: true, value: null });
    kv.get.mockResolvedValue({ ok: false, reason: 'http_error' });
    expect(await claimSync(KEY)).toEqual({ kind: 'in-flight' });
  });
});

describe('finalizeSync / releaseSync', () => {
  it('finalizeSync: 書込成功で true・dealId を TTL 無しで上書き', async () => {
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    expect(await finalizeSync(KEY, 42)).toBe(true);
    expect(kv.set).toHaveBeenCalledWith(KEY, '42');
  });

  it('finalizeSync: KV 書込失敗で false (synced 扱い不可・二重作成防止)', async () => {
    kv.set.mockResolvedValue({ ok: false, reason: 'http_error' });
    expect(await finalizeSync(KEY, 42)).toBe(false);
  });

  it('releaseSync: claim を削除', async () => {
    kv.del.mockResolvedValue({ ok: true, value: 1 });
    await releaseSync(KEY);
    expect(kv.del).toHaveBeenCalledWith(KEY);
  });
});

describe('token / state JSON 直列化 (wallet 名前空間)', () => {
  const TOKEN: StoredToken = {
    access: 'A',
    refresh: 'R',
    expiresAt: 123,
    companyId: 7,
  };

  it('setToken/getToken: wallet 小文字キーで round-trip', async () => {
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    await setToken('0xABCDEF', TOKEN);
    expect(kv.set).toHaveBeenCalledWith('freee:tok:0xabcdef', JSON.stringify(TOKEN));

    kv.get.mockResolvedValue({ ok: true, value: JSON.stringify(TOKEN) });
    expect(await getToken('0xABCDEF')).toEqual(TOKEN);
    expect(kv.get).toHaveBeenCalledWith('freee:tok:0xabcdef');
  });

  it('setToken: KV 書込失敗で throw (refresh rotation 未永続を露出)', async () => {
    kv.set.mockResolvedValue({ ok: false, reason: 'http_error' });
    await expect(setToken('0xabc', TOKEN)).rejects.toThrow('freee_token_persist_failed');
  });

  it('getToken: 未存在 → null・壊れた JSON → null', async () => {
    kv.get.mockResolvedValue({ ok: true, value: null });
    expect(await getToken('0xabc')).toBeNull();
    kv.get.mockResolvedValue({ ok: true, value: '{not json' });
    expect(await getToken('0xabc')).toBeNull();
  });

  it('setState: NX 成功で true・衝突で false', async () => {
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    expect(await setState('st8', { wallet: '0xabc', returnTo: '/ja/history' })).toBe(true);
    kv.set.mockResolvedValue({ ok: true, value: null });
    expect(await setState('st8', { wallet: '0xabc', returnTo: '/' })).toBe(false);
  });

  it('consumeState: GETDEL で atomic に取得+削除 (1 回限り)', async () => {
    const value = { wallet: '0xabc', returnTo: '/ja/history' };
    kv.getdel.mockResolvedValue({ ok: true, value: JSON.stringify(value) });
    expect(await consumeState('st8')).toEqual(value);
    expect(kv.getdel).toHaveBeenCalledWith('freee:state:st8');
  });

  it('consumeState: 未存在 → null', async () => {
    kv.getdel.mockResolvedValue({ ok: true, value: null });
    expect(await consumeState('x')).toBeNull();
  });
});
