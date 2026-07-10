import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// KV 境界のみ mock。_store の冪等 claim 状態機械 / JSON 直列化を本物のまま実行する。
const kv = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  getdel: vi.fn(),
  setNxGet: vi.fn(),
}));
vi.mock('@/lib/kv', () => ({
  kvGet: (...a: unknown[]) => kv.get(...a),
  kvSet: (...a: unknown[]) => kv.set(...a),
  kvDel: (...a: unknown[]) => kv.del(...a),
  kvGetDel: (...a: unknown[]) => kv.getdel(...a),
  kvSetNxGet: (...a: unknown[]) => kv.setNxGet(...a),
}));

import {
  claimSync,
  finalizeSync,
  releaseSync,
  getToken,
  setToken,
  setMapping,
  delMapping,
  setState,
  consumeState,
} from '@/app/api/freee/_store';
import { encryptStoredToken, type StoredToken } from '@/lib/freee';

const KEY = 'freee:synced:0xabc:0xtx';
const ENC_KEY = '00'.repeat(32);
const OTHER_ENC_KEY = '11'.repeat(32);
let oldEncKey: string | undefined;

beforeEach(() => {
  oldEncKey = process.env.FREEE_TOKEN_ENC_KEY;
  process.env.FREEE_TOKEN_ENC_KEY = ENC_KEY;
  kv.get.mockReset();
  kv.set.mockReset();
  kv.del.mockReset();
  kv.getdel.mockReset();
  kv.setNxGet.mockReset();
});

afterEach(() => {
  if (oldEncKey === undefined) {
    delete process.env.FREEE_TOKEN_ENC_KEY;
  } else {
    process.env.FREEE_TOKEN_ENC_KEY = oldEncKey;
  }
});

// REM-21: claimSync は kvSetNxGet (SET NX GET 原子化) を使う。
// kvSetNxGet は null=新設(fresh) / 旧値=既存(in-flight or done)。
describe('claimSync (SET NX GET 原子化・REM-21)', () => {
  it('fresh: kvSetNxGet が null → pending を TTL 付きで claim', async () => {
    kv.setNxGet.mockResolvedValue({ ok: true, value: null });
    expect(await claimSync(KEY)).toEqual({ kind: 'fresh' });
    expect(kv.setNxGet).toHaveBeenCalledWith(KEY, 'pending', 300);
    // kvGet / kvSet は不使用 (原子化済)
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.set).not.toHaveBeenCalled();
  });

  it('done: 既存値が数値 → 既存 dealId を返す', async () => {
    kv.setNxGet.mockResolvedValue({ ok: true, value: '9001' });
    expect(await claimSync(KEY)).toEqual({ kind: 'done', dealId: 9001 });
  });

  it('in-flight: 既存値が pending', async () => {
    kv.setNxGet.mockResolvedValue({ ok: true, value: 'pending' });
    expect(await claimSync(KEY)).toEqual({ kind: 'in-flight' });
  });

  it('in-flight: 既存値が非数値 (異常値) でも安全に in-flight 扱い', async () => {
    kv.setNxGet.mockResolvedValue({ ok: true, value: 'garbage' });
    expect(await claimSync(KEY)).toEqual({ kind: 'in-flight' });
  });

  it('in-flight: KV 失敗 (ok:false) → 安全側 in-flight (skip)', async () => {
    kv.setNxGet.mockResolvedValue({ ok: false, reason: 'http_error' });
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

  it('setToken/getToken: wallet 小文字キーで encrypted envelope round-trip', async () => {
    kv.set.mockResolvedValue({ ok: true, value: 'OK' });
    await setToken('0xABCDEF', TOKEN);
    expect(kv.set).toHaveBeenCalledWith('freee:tok:0xabcdef', expect.any(String));
    const saved = kv.set.mock.calls[0][1] as string;
    expect(saved).not.toBe(JSON.stringify(TOKEN));
    expect(JSON.parse(saved)).toMatchObject({ v: 1, alg: 'A256GCM' });

    kv.get.mockResolvedValue({ ok: true, value: saved });
    expect(await getToken('0xABCDEF')).toEqual(TOKEN);
    expect(kv.get).toHaveBeenCalledWith('freee:tok:0xabcdef');
  });

  it('setToken: KV 書込失敗で throw (refresh rotation 未永続を露出)', async () => {
    kv.set.mockResolvedValue({ ok: false, reason: 'http_error' });
    await expect(setToken('0xabc', TOKEN)).rejects.toThrow('freee_token_persist_failed');
  });

  it('getToken: 未存在 → null・壊れた/legacy JSON → null and delete', async () => {
    kv.get.mockResolvedValue({ ok: true, value: null });
    expect(await getToken('0xabc')).toBeNull();
    kv.get.mockResolvedValue({ ok: true, value: '{not json' });
    expect(await getToken('0xabc')).toBeNull();
    kv.get.mockResolvedValue({ ok: true, value: JSON.stringify(TOKEN) });
    expect(await getToken('0xabc')).toBeNull();
    expect(kv.del).toHaveBeenCalledWith('freee:tok:0xabc');
  });

  it('getToken: tampered ct/tag → decrypt fails → null and delete', async () => {
    const envelope = JSON.parse(encryptStoredToken('0xabc', TOKEN)) as { ct: string };
    envelope.ct = Buffer.from('tampered').toString('base64');
    kv.get.mockResolvedValue({ ok: true, value: JSON.stringify(envelope) });
    expect(await getToken('0xabc')).toBeNull();
    expect(kv.del).toHaveBeenCalledWith('freee:tok:0xabc');
  });

  it('getToken: wrong encryption key → null and delete', async () => {
    const saved = encryptStoredToken('0xabc', TOKEN);
    process.env.FREEE_TOKEN_ENC_KEY = OTHER_ENC_KEY;
    kv.get.mockResolvedValue({ ok: true, value: saved });
    expect(await getToken('0xabc')).toBeNull();
    expect(kv.del).toHaveBeenCalledWith('freee:tok:0xabc');
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

describe('mapping 永続化結果', () => {
  const MAPPING = { companyId: 7, accountItemId: 101, taxCode: 21 };

  it('setMapping: KV 保存成功時のみ true', async () => {
    kv.set.mockResolvedValueOnce({ ok: true, value: 'OK' });
    await expect(setMapping('0xABC', MAPPING)).resolves.toBe(true);
    expect(kv.set).toHaveBeenCalledWith('freee:map:0xabc', JSON.stringify(MAPPING));

    kv.set.mockResolvedValueOnce({ ok: false, reason: 'network_error' });
    await expect(setMapping('0xABC', MAPPING)).resolves.toBe(false);
  });

  it('delMapping: DEL=0 も成功・KV 失敗時のみ false', async () => {
    kv.del.mockResolvedValueOnce({ ok: true, value: 0 });
    await expect(delMapping('0xABC')).resolves.toBe(true);
    expect(kv.del).toHaveBeenCalledWith('freee:map:0xabc');

    kv.del.mockResolvedValueOnce({ ok: false, reason: 'http_error' });
    await expect(delMapping('0xABC')).resolves.toBe(false);
  });
});
