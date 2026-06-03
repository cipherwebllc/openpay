import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => false,
  kvGet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvSet: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
  kvDel: vi.fn(async () => ({ ok: false, reason: 'unconfigured' })),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { GET as statusGET } from '@/app/api/entitlement/status/route';
import { POST as grantPOST } from '@/app/api/entitlement/grant/route';

const ORIG_TOKEN = process.env.PAYMENT_LOG_ADMIN_TOKEN;
afterEach(() => {
  if (ORIG_TOKEN === undefined) delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
  else process.env.PAYMENT_LOG_ADMIN_TOKEN = ORIG_TOKEN;
});

function grantReq(auth?: string, body: unknown = { wallet: '0x0' }): Request {
  return new Request('http://localhost/api/entitlement/grant', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('entitlement routes', () => {
  it('status: 未ログイン → 401', async () => {
    const res = await statusGET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('grant: admin token 未設定 → 503 admin_token_not_configured', async () => {
    delete process.env.PAYMENT_LOG_ADMIN_TOKEN;
    const res = await grantPOST(grantReq());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'admin_token_not_configured' });
  });

  it('grant: 誤った Bearer → 401 unauthorized', async () => {
    process.env.PAYMENT_LOG_ADMIN_TOKEN = 'secret';
    const res = await grantPOST(grantReq('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });
});
