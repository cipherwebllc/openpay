// /api/order/token (受注閲覧トークンの発行/再表示/取消) を実ルートで検証。
// SIWE = オーナー本人のみ / flag OFF=404 / KV障害=503 / 発行は KV に rev+key を書く / rotate は旧 rev を消す /
// revoke は key を消す (= feed の現行一致検証で全トークン失効)。orderToken は実コード・KV/SIWE は mock。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { orderTokenKey, orderTokenRevKey, isOrderTokenLike } from '@/lib/orderToken';

const SESSION = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enableOrderToken: true,
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false },
  kvConfigured: true,
  store: {} as Record<string, string | null>,
  kvOk: true, // false で全 KV 操作を失敗させる
  failSetKey: null as string | null, // この key への kvSet だけ失敗させる (部分失敗テスト用)
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderToken() {
        return hold.enableOrderToken;
      },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: async () =>
    hold.session.ok
      ? hold.session
      : { ok: false, response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) },
}));
const delSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => hold.kvConfigured,
  kvGet: (key: string) =>
    Promise.resolve(
      hold.kvOk
        ? { ok: true, value: key in hold.store ? hold.store[key] : null }
        : { ok: false, reason: 'network_error' },
    ),
  kvSet: (key: string, value: string) => {
    if (!hold.kvOk || key === hold.failSetKey) return Promise.resolve({ ok: false, reason: 'network_error' });
    hold.store[key] = value;
    return Promise.resolve({ ok: true, value: 'OK' });
  },
  kvDel: (key: string) => {
    delSpy(key);
    if (!hold.kvOk) return Promise.resolve({ ok: false, reason: 'network_error' });
    const had = key in hold.store;
    delete hold.store[key];
    return Promise.resolve({ ok: true, value: had ? 1 : 0 });
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET, POST, DELETE } from '@/app/api/order/token/route';

beforeEach(() => {
  hold.enableOrderToken = true;
  hold.session = { ok: true, address: SESSION };
  hold.kvConfigured = true;
  hold.store = {};
  hold.kvOk = true;
  hold.failSetKey = null;
  delSpy.mockClear();
});

describe('GET /api/order/token (現行トークンの再表示)', () => {
  it('flag OFF → 404', async () => {
    hold.enableOrderToken = false;
    expect((await GET()).status).toBe(404);
  });
  it('未ログイン → 401', async () => {
    hold.session = { ok: false };
    expect((await GET()).status).toBe(401);
  });
  it('KV 未設定 → 503', async () => {
    hold.kvConfigured = false;
    expect((await GET()).status).toBe(503);
  });
  it('未発行 → token:null', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, token: null });
  });
  it('発行済み → そのトークンを返す (再表示)', async () => {
    hold.store[orderTokenKey(SESSION)] = 'x'.repeat(43);
    const res = await GET();
    expect(await res.json()).toEqual({ ok: true, token: 'x'.repeat(43) });
  });
  // C11: トークンは秘密。共有キャッシュ (CDN/proxy) に載せない。
  it('成功応答に Cache-Control: private, no-store', async () => {
    hold.store[orderTokenKey(SESSION)] = 'x'.repeat(43);
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('POST /api/order/token (発行 / 再発行)', () => {
  it('flag OFF → 404 / 未ログイン → 401', async () => {
    hold.enableOrderToken = false;
    expect((await POST()).status).toBe(404);
    hold.enableOrderToken = true;
    hold.session = { ok: false };
    expect((await POST()).status).toBe(401);
  });

  it('発行: 有効形式トークンを返し、key(merchant)=token と rev(token)=merchant を書く', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const { ok, token } = await res.json();
    expect(ok).toBe(true);
    expect(isOrderTokenLike(token)).toBe(true); // base64url 43 文字
    expect(hold.store[orderTokenKey(SESSION)]).toBe(token); // 再表示用ポインタ
    expect(hold.store[orderTokenRevKey(token)]).toBe(SESSION); // lookup 用 (checksum 保存)
  });

  it('再発行: 旧 rev を削除し新トークンに差し替え (旧トークン失効)', async () => {
    const old = 'o'.repeat(43);
    hold.store[orderTokenKey(SESSION)] = old;
    hold.store[orderTokenRevKey(old)] = SESSION;
    const res = await POST();
    const { token } = await res.json();
    expect(token).not.toBe(old);
    expect(hold.store[orderTokenKey(SESSION)]).toBe(token); // 現行は新トークン
    expect(orderTokenRevKey(old) in hold.store).toBe(false); // 旧 rev は掃除済み
    expect(delSpy).toHaveBeenCalledWith(orderTokenRevKey(old));
  });

  it('KV 障害 → 503', async () => {
    hold.kvOk = false;
    expect((await POST()).status).toBe(503);
  });

  it('部分失敗 fail-safe: pointer 書込だけ失敗 → 503 かつ旧トークンは生存 (rev 先行ゆえロックアウトしない)', async () => {
    const old = 'o'.repeat(43);
    hold.store[orderTokenKey(SESSION)] = old;
    hold.store[orderTokenRevKey(old)] = SESSION;
    hold.failSetKey = orderTokenKey(SESSION); // pointer への SET だけ失敗 (rev は先に成功)
    const res = await POST();
    expect(res.status).toBe(503);
    // pointer は旧トークンのまま = 旧トークンは feed の現行一致検証を通る (= 失効していない・運用継続可)。
    expect(hold.store[orderTokenKey(SESSION)]).toBe(old);
    expect(hold.store[orderTokenRevKey(old)]).toBe(SESSION); // 旧 rev も健在
  });
});

describe('DELETE /api/order/token (取消)', () => {
  it('flag OFF → 404 / 未ログイン → 401', async () => {
    hold.enableOrderToken = false;
    expect((await DELETE()).status).toBe(404);
    hold.enableOrderToken = true;
    hold.session = { ok: false };
    expect((await DELETE()).status).toBe(401);
  });

  it('取消: key(merchant) を削除 = 以後どのトークンも失効 (rev も掃除)', async () => {
    const tok = 't'.repeat(43);
    hold.store[orderTokenKey(SESSION)] = tok;
    hold.store[orderTokenRevKey(tok)] = SESSION;
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(orderTokenKey(SESSION) in hold.store).toBe(false); // 現行ポインタ消滅 = 失効成立
    expect(orderTokenRevKey(tok) in hold.store).toBe(false); // rev も掃除
  });

  it('KV del 失敗 → 503 (失効が成立しないので成功扱いしない)', async () => {
    hold.store[orderTokenKey(SESSION)] = 't'.repeat(43);
    hold.kvOk = false;
    expect((await DELETE()).status).toBe(503);
  });
});
