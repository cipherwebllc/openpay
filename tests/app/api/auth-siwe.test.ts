import { describe, it, expect, vi } from 'vitest';

// KV を境界 mock: 未設定状態を固定し env-gate (503) と「cookie 無し」分岐を決定的に検証。
// 署名検証フローの全分岐は lib/siwe (siwe.test) で担保。ここは route のアダプタ薄層を確認。
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => false,
  kvGet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvSet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvDel: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
}));

// next/headers cookies() を request-scope 外でも使えるよう stub (cookie 無し状態)。
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
  }),
}));

import { POST as noncePOST } from '@/app/api/auth/siwe/nonce/route';
import { POST as verifyPOST } from '@/app/api/auth/siwe/verify/route';
import { GET as meGET } from '@/app/api/auth/siwe/me/route';
import { POST as logoutPOST } from '@/app/api/auth/siwe/logout/route';

describe('SIWE routes', () => {
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

  it('logout: cookie 無しでも 200 (冪等) + op_sess を maxAge0 で失効', async () => {
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('op_sess=');
    expect(setCookie.toLowerCase()).toContain('max-age=0');
  });
});
