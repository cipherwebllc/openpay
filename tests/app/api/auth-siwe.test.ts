import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  const ipRate = { allowed: true };
  return {
    cookieToken: undefined as string | undefined,
    kvConfigured: false,
    kvDel: vi.fn(),
    kvGet: vi.fn(),
    kvSet: vi.fn(),
    ipRate,
    checkIpRateLimit: vi.fn(
      async (_scope: string, hashedIp: string | null) =>
        hashedIp === null || ipRate.allowed,
    ),
  };
});

// KV を境界 mock: 未設定状態を固定し env-gate (503) と「cookie 無し」分岐を決定的に検証。
// 署名検証フローの全分岐は lib/siwe (siwe.test) で担保。ここは route のアダプタ薄層を確認。
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => h.kvConfigured,
  kvGet: h.kvGet,
  kvSet: h.kvSet,
  kvDel: h.kvDel,
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: h.checkIpRateLimit,
}));

// next/headers cookies() を request-scope 外でも使えるよう stub (cookie 無し状態)。
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === (process.env.NODE_ENV === 'production' ? '__Host-op_sess' : 'op_sess') && h.cookieToken !== undefined
        ? { value: h.cookieToken }
        : undefined,
  }),
}));

import { POST as noncePOST } from '@/app/api/auth/siwe/nonce/route';
import { POST as verifyPOST } from '@/app/api/auth/siwe/verify/route';
import { GET as meGET } from '@/app/api/auth/siwe/me/route';
import { POST as logoutPOST } from '@/app/api/auth/siwe/logout/route';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { newSessionToken, sessionKey } from '@/lib/siwe';

const SESSION_TOKEN = '0123456789abcdef'.repeat(4);
const MALFORMED_TOKENS = [
  '',
  'not-a-session',
  'a'.repeat(63),
  'a'.repeat(65),
  'A'.repeat(64),
  'a'.repeat(63) + 'B',
  'g'.repeat(64),
  '0x' + 'a'.repeat(64),
  ' ' + 'a'.repeat(64),
  'a'.repeat(64) + '\n',
];

function nonceReq(ip?: string): Request {
  return new Request('http://localhost/api/auth/siwe/nonce', {
    method: 'POST',
    headers: ip ? { 'x-vercel-forwarded-for': ip } : undefined,
  });
}

describe('SIWE routes', () => {
  beforeEach(() => {
    h.cookieToken = undefined;
    h.kvConfigured = false;
    h.kvDel.mockReset();
    h.kvDel.mockResolvedValue({ ok: true, value: 0 });
    h.kvGet.mockReset();
    h.kvGet.mockResolvedValue({ ok: false, reason: 'unconfigured' });
    h.kvSet.mockReset();
    h.kvSet.mockResolvedValue({ ok: false, reason: 'unconfigured' });
    h.ipRate.allowed = true;
    h.checkIpRateLimit.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('nonce: KV 未設定 → 503 kv_not_configured', async () => {
    const res = await noncePOST(nonceReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'kv_not_configured' });
  });

  it('nonce: IP rate limit → nonce 生成/KV 書込前に 429 + Retry-After', async () => {
    h.kvConfigured = true;
    h.ipRate.allowed = false;
    vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');

    const res = await noncePOST(nonceReq('203.0.113.10'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(h.checkIpRateLimit).toHaveBeenCalledWith(
      'siwe-nonce',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      60,
      60,
    );
    expect(h.kvSet).not.toHaveBeenCalled();
  });

  it('nonce: IP_HASH_SECRET 未設定なら IP limiter は inert で既存フローを維持', async () => {
    h.kvConfigured = true;
    h.ipRate.allowed = false;
    h.kvSet.mockResolvedValue({ ok: true, value: 'OK' });
    vi.stubEnv('IP_HASH_SECRET', '');

    const res = await noncePOST(nonceReq('203.0.113.10'));

    expect(res.status).toBe(200);
    expect(h.checkIpRateLimit).toHaveBeenCalledWith('siwe-nonce', null, 60, 60);
    expect(h.kvSet).toHaveBeenCalledOnce();
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

  it('verify: KV 設定時の 8KiB 超 body → JSON/署名検証前に 413', async () => {
    h.kvConfigured = true;
    const req = new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(9 * 1024), signature: '0x1' }),
    });
    const res = await verifyPOST(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'payload_too_large',
    });
  });

  it('verify: IP rate limit → body cap/署名検証前に 429 + Retry-After', async () => {
    h.kvConfigured = true;
    h.ipRate.allowed = false;
    vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
    const req = new Request('http://localhost/api/auth/siwe/verify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-forwarded-for': '203.0.113.11',
      },
      body: JSON.stringify({ message: 'x'.repeat(9 * 1024), signature: '0x1' }),
    });

    const res = await verifyPOST(req);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(h.checkIpRateLimit).toHaveBeenCalledWith(
      'siwe-verify',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      30,
      60,
    );
    expect(h.kvDel).not.toHaveBeenCalled();
  });

  it('me: cookie 無し → 200 address:null (未ログインも正常状態)', async () => {
    const res = await meGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: null });
    expect(h.kvGet).not.toHaveBeenCalled();
  });

  describe.each(['test', 'production'])('session cookie shape (%s)', (nodeEnv) => {
    it.each(MALFORMED_TOKENS)('logout: malformed cookie %j is cleared without KV deletion', async (token) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = token;

      const res = await logoutPOST();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(h.kvDel).not.toHaveBeenCalled();
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(nodeEnv === 'production' ? '__Host-op_sess=' : 'op_sess=');
      expect(setCookie.toLowerCase()).toContain('max-age=0');
      expect(setCookie.toLowerCase()).toContain('path=/');
      if (nodeEnv === 'production') expect(setCookie.toLowerCase()).toContain('secure');
    });

    it('logout: valid session is deleted from KV and the cookie is cleared', async () => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = SESSION_TOKEN;
      h.kvDel.mockResolvedValue({ ok: true, value: 1 });

      const res = await logoutPOST();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(h.kvDel).toHaveBeenCalledOnce();
      expect(h.kvDel).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
      expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
    });

    it.each(MALFORMED_TOKENS)('malformed cookie %j stays signed out without a KV read', async (token) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = token;
      h.kvGet.mockResolvedValue({ ok: true, value: null });

      const res = await meGET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, address: null });
      expect(res.headers.get('cache-control')).toBe('private, no-store');

      const session = await requireSession();
      expect(session.ok).toBe(false);
      if (session.ok) throw new Error('expected signed-out session');
      expect(session.response.status).toBe(401);
      expect(await session.response.json()).toEqual({ ok: false, error: 'unauthenticated' });
      expect(h.kvGet).not.toHaveBeenCalled();
    });

    it('server-issued cookie still authenticates through KV', async () => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      h.cookieToken = newSessionToken();
      const address = '0x1111111111111111111111111111111111111111';
      h.kvGet.mockResolvedValue({ ok: true, value: JSON.stringify({ address }) });

      const res = await meGET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, address });
      expect(await requireSession()).toEqual({ ok: true, address });
      expect(h.kvGet).toHaveBeenCalledTimes(2);
      expect(h.kvGet).toHaveBeenCalledWith(sessionKey(h.cookieToken));
    });
  });

  it('me: Cache-Control: private, no-store を返す (CDN キャッシュ汚染防止)', async () => {
    const res = await meGET();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('me: cookie 有りで KV 読取障害 → 503 (未ログイン成功に偽装しない)', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvGet.mockResolvedValue({ ok: false, reason: 'network_error' });

    const res = await meGET();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'session_storage_unavailable',
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.kvGet).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
  });

  it('requireSession: cookie 有りで KV 読取障害 → 503 (401 と区別)', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvGet.mockResolvedValue({ ok: false, reason: 'timeout' });

    const session = await requireSession();

    expect(session.ok).toBe(false);
    if (session.ok) throw new Error('expected session read failure');
    expect(session.response.status).toBe(503);
    expect(await session.response.json()).toEqual({
      ok: false,
      error: 'session_storage_unavailable',
    });
  });

  it('me: cookie の KV record が miss → 従来どおり 200 address:null', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvGet.mockResolvedValue({ ok: true, value: null });

    const res = await meGET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, address: null });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.kvGet).toHaveBeenCalledOnce();
    expect(h.kvGet).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
    const session = await requireSession();
    expect(session.ok).toBe(false);
    if (session.ok) throw new Error('expected unknown session');
    expect(session.response.status).toBe(401);
    expect(await session.response.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(h.kvGet).toHaveBeenCalledTimes(2);
  });

  it('logout: cookie 無しでも 200 (冪等) + op_sess を maxAge0 で失効', async () => {
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('op_sess=');
    expect(setCookie.toLowerCase()).toContain('max-age=0');
  });

  // C7: 本番の cookie 名は `__Host-op_sess`。ブラウザの受理条件 (Secure + Path=/ +
  // Domain 属性なし) を 3 つとも満たしていなければ prefix cookie は黙って捨てられる。
  it('logout: 本番は __Host-op_sess を Secure + Path=/ + Domain 無しで失効させる', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await logoutPOST();
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-op_sess=');
    const lower = setCookie.toLowerCase();
    expect(lower).toContain('secure');
    expect(lower).toContain('path=/');
    expect(lower).not.toContain('domain=');
  });

  it('logout: セッションが既に無い (DEL=0) → 200 (冪等) + cookie 失効', async () => {
    h.cookieToken = SESSION_TOKEN;
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.kvDel).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
    expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
  });

  it('logout: KV 削除失敗 → 503 だが cookie は失効', async () => {
    h.cookieToken = SESSION_TOKEN;
    h.kvDel.mockResolvedValue({ ok: false, reason: 'network_error' });
    const res = await logoutPOST();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'session_revoke_failed' });
    expect(h.kvDel).toHaveBeenCalledWith(sessionKey(SESSION_TOKEN));
    expect(res.headers.get('set-cookie')?.toLowerCase()).toContain('max-age=0');
  });
});
