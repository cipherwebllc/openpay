import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cookieToken: undefined as string | undefined,
  kvDel: vi.fn(),
}));

// KV を境界 mock: 未設定状態を固定し env-gate (503) と「cookie 無し」分岐を決定的に検証。
// 署名検証フローの全分岐は lib/siwe (siwe.test) で担保。ここは route のアダプタ薄層を確認。
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => false,
  kvGet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvSet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvDel: h.kvDel,
}));

// next/headers cookies() を request-scope 外でも使えるよう stub (cookie 無し状態)。
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'op_sess' && h.cookieToken ? { value: h.cookieToken } : undefined,
  }),
}));

import { POST as noncePOST } from '@/app/api/auth/siwe/nonce/route';
import { POST as verifyPOST } from '@/app/api/auth/siwe/verify/route';
import { GET as meGET } from '@/app/api/auth/siwe/me/route';
import { POST as logoutPOST } from '@/app/api/auth/siwe/logout/route';

describe('SIWE routes', () => {
  beforeEach(() => {
    h.cookieToken = undefined;
    h.kvDel.mockReset();
    h.kvDel.mockResolvedValue({ ok: true, value: 0 });
  });

  it('nonce: KV 未設定 → 503 kv_not_configured', async () => {
    const res = await noncePOST();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_not_configured' });
  });

  it('verify: KV 未設定 → 503 (署名検証に到達しない)', async () => {
    const req = new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x', signature: '0x1' }),
    });
    const res = await verifyPOST(req);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_not_configured' });
  });

  it('me: cookie 無し → 200 address:null (未ログインも正常状態)', async () => {
    const res = await meGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: null });
  });

  it('me: Cache-Control: private, no-store を返す (CDN キャッシュ汚染防止)', async () => {
    const res = await meGET();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('logout: cookie 無しでも 200 (冪等) + op_sess を maxAge0 で失効', async () => {
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('op_sess=');
    expect(setCookie.toLowerCase()).toContain('max-age=0');
  });

  it('logout: セッションが既に無い (DEL=0) → 200 (冪等) + cookie 失効', async () => {
    h.cookieToken = 'already-revoked';
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.kvDel).toHaveBeenCalledWith('siwe:sess:already-revoked');
    expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
  });

  it('logout: KV 削除失敗 → 503 だが cookie は失効', async () => {
    h.cookieToken = 'live-session';
    h.kvDel.mockResolvedValue({ ok: false, reason: 'network_error' });
    const res = await logoutPOST();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'session_revoke_failed' });
    expect(h.kvDel).toHaveBeenCalledWith('siwe:sess:live-session');
    expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
  });
});
