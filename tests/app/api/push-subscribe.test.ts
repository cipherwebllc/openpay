import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const SESSION_ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enablePushNotify: true,
  pushVapidPublicKey: 'test-public-key',
  session: { ok: true, address: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' } as
    | { ok: true; address: string }
    | { ok: false; response: unknown },
  rateAllowed: true,
  upsertOk: true,
  removeOk: true,
}));

vi.mock('@/lib/env', () => ({
  env: {
    get enablePushNotify() {
      return hold.enablePushNotify;
    },
    get pushVapidPublicKey() {
      return hold.pushVapidPublicKey;
    },
  },
}));

const requireSessionSpy = vi.hoisted(() => vi.fn());
vi.mock('@/app/api/auth/siwe/_session', () => ({
  requireSession: () => {
    requireSessionSpy();
    return Promise.resolve(
      hold.session.ok
        ? hold.session
        : {
            ok: false,
            response: NextResponse.json(
              { ok: false, error: 'unauthenticated' },
              { status: 401 },
            ),
          },
    );
  },
}));

const rateSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/relay/relayGuards', () => ({
  checkReadRateLimit: (...args: unknown[]) => {
    rateSpy(...args);
    return Promise.resolve(hold.rateAllowed);
  },
}));

const storeSpy = vi.hoisted(() => ({
  upsert: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/lib/push/store', () => ({
  upsertPushSubscription: (...args: unknown[]) => {
    storeSpy.upsert(...args);
    return Promise.resolve(
      hold.upsertOk
        ? { ok: true, value: [{ endpoint: 'https://push.example/sub/1' }] }
        : { ok: false, reason: 'kv_error' },
    );
  },
  removePushSubscription: (...args: unknown[]) => {
    storeSpy.remove(...args);
    return Promise.resolve(
      hold.removeOk ? { ok: true, value: [] } : { ok: false, reason: 'kv_error' },
    );
  },
}));

import { DELETE, POST } from '@/app/api/push/subscribe/route';

const subscription = {
  endpoint: 'https://push.example/sub/1',
  keys: {
    p256dh: 'A'.repeat(87),
    auth: 'B'.repeat(22),
  },
};

function req(method: 'POST' | 'DELETE', body: unknown): Request {
  return new Request('http://localhost/api/push/subscribe', {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.55',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hold.enablePushNotify = true;
  hold.pushVapidPublicKey = 'test-public-key';
  hold.session = { ok: true, address: SESSION_ADDR };
  hold.rateAllowed = true;
  hold.upsertOk = true;
  hold.removeOk = true;
  requireSessionSpy.mockClear();
  rateSpy.mockClear();
  storeSpy.upsert.mockClear();
  storeSpy.remove.mockClear();
});

describe('/api/push/subscribe', () => {
  it('flag OFF → 404 (認証や保存へ進まない)', async () => {
    hold.enablePushNotify = false;
    const res = await POST(req('POST', { subscription, locale: 'ja' }));
    expect(res.status).toBe(404);
    expect(requireSessionSpy).not.toHaveBeenCalled();
    expect(storeSpy.upsert).not.toHaveBeenCalled();
  });

  it('未ログイン → 401', async () => {
    hold.session = { ok: false, response: null };
    const res = await POST(req('POST', { subscription, locale: 'ja' }));
    expect(res.status).toBe(401);
    expect(storeSpy.upsert).not.toHaveBeenCalled();
  });

  it('不正 shape → 400', async () => {
    const res = await POST(
      req('POST', {
        subscription: {
          endpoint: 'http://push.example/sub/1',
          keys: { p256dh: 'not+base64url', auth: 'B'.repeat(22) },
        },
        locale: 'ja',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(storeSpy.upsert).not.toHaveBeenCalled();
  });

  it('正常 POST は body の wallet を無視し SIWE address で upsert する', async () => {
    const res = await POST(
      req('POST', {
        wallet: '0x000000000000000000000000000000000000dEaD',
        subscription,
        locale: 'en',
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, count: 1 });
    expect(rateSpy).toHaveBeenCalledWith(
      `pushsub:${SESSION_ADDR.toLowerCase()}:203.0.113.0/24`,
      20,
      60,
    );
    expect(storeSpy.upsert).toHaveBeenCalledWith(SESSION_ADDR, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      locale: 'en',
    });
  });

  it('DELETE は endpoint を SIWE address の購読から削除する', async () => {
    const res = await DELETE(req('DELETE', { endpoint: subscription.endpoint }));

    expect(res.status).toBe(200);
    expect(storeSpy.remove).toHaveBeenCalledWith(SESSION_ADDR, {
      endpoint: subscription.endpoint,
    });
  });
});
