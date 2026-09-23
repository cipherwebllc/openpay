import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

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
  listOk: true,
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
  list: vi.fn(),
}));
vi.mock('@/lib/push/store', () => ({
  listPushSubscriptions: (...args: unknown[]) => {
    storeSpy.list(...args);
    return Promise.resolve(hold.listOk ? { ok: true, value: [{
      endpoint: 'https://fcm.googleapis.com/sub/1', includeAmount: true,
      endpointHash: createHash('sha256').update('https://fcm.googleapis.com/sub/1').digest('hex'),
      keys: { p256dh: 'secret', auth: 'secret' },
    }] } : { ok: false, reason: 'kv_error' });
  },
  upsertPushSubscription: (...args: unknown[]) => {
    storeSpy.upsert(...args);
    return Promise.resolve(
      hold.upsertOk
        ? { ok: true, value: [{ endpoint: 'https://fcm.googleapis.com/sub/1' }] }
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

import * as subscribeRoute from '@/app/api/push/subscribe/route';
import { DELETE, POST } from '@/app/api/push/subscribe/route';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/sub/1',
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
  hold.listOk = true;
  storeSpy.list.mockClear();
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

  it.each([
    'https://127.0.0.1/push',
    'https://[::1]/push',
    'https://push.local/sub/1',
    'https://push.internal/sub/1',
  ])('POST は private/loopback endpoint を保存しない: %s', async (endpoint) => {
    const res = await POST(
      req('POST', {
        subscription: { ...subscription, endpoint },
        locale: 'ja',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(storeSpy.upsert).not.toHaveBeenCalled();
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/token',
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://push.services.mozilla.com/push/token',
    'https://web.push.apple.com/token',
    'https://region.web.push.apple.com/token',
    'https://wns2-par02p.notify.windows.com/token',
    'https://region.wns.notify.windows.com/token',
    'https://FCM.GOOGLEAPIS.COM:443/token',
    'https://fcm.googleapis.com./token',
  ])('POST accepts a known HTTPS push service: %s', async (endpoint) => {
    const res = await POST(req('POST', {
      subscription: { ...subscription, endpoint }, locale: 'ja',
    }));
    expect(res.status).toBe(200);
    expect(storeSpy.upsert).toHaveBeenCalledWith(SESSION_ADDR,
      expect.objectContaining({ endpoint }));
  });

  it.each([
    'https://example.com/push',
    'https://8.8.8.8/push',
    'https://[2606:4700::1111]/push',
    'http://fcm.googleapis.com/push',
    'https://fcm.googleapis.com.evil.example/push',
    'https://evilfcm.googleapis.com/push',
    'https://evil.fcm.googleapis.com/push',
    'https://evil.push.services.mozilla.com/push',
    'https://updates.push.services.mozilla.com.evil.example/push',
    'https://push.apple.com/push',
    'https://evilpush.apple.com/push',
    'https://web.push.apple.com.evil.example/push',
    'https://notify.windows.com/push',
    'https://evilnotify.windows.com/push',
    'https://wns.notify.windows.com.evil.example/push',
    'https://fcm.googleapis.com@evil.example/push',
    'https://user:pass@fcm.googleapis.com/push',
    'https://fcm.googleapis.com:8443/push',
  ])('POST rejects an untrusted push endpoint before storage: %s', async (endpoint) => {
    const res = await POST(req('POST', {
      subscription: { ...subscription, endpoint }, locale: 'ja',
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(storeSpy.upsert).not.toHaveBeenCalled();
  });

  it('DELETE still removes a legacy subscription on an arbitrary public host', async () => {
    const endpoint = 'https://push.example/legacy';
    const res = await DELETE(req('DELETE', { endpoint }));
    expect(res.status).toBe(200);
    expect(storeSpy.remove).toHaveBeenCalledWith(SESSION_ADDR, { endpoint });
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
      includeAmount: false,
    });
  });

  it('includeAmount:true を透過して upsert する', async () => {
    const res = await POST(
      req('POST', { subscription, locale: 'ja', includeAmount: true }),
    );

    expect(res.status).toBe(200);
    expect(storeSpy.upsert).toHaveBeenCalledWith(SESSION_ADDR, {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      locale: 'ja',
      includeAmount: true,
    });
  });

  it('includeAmount が boolean でなければ 400 (保存へ進まない)', async () => {
    const res = await POST(
      req('POST', { subscription, locale: 'ja', includeAmount: 'yes' }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_payload' });
    expect(storeSpy.upsert).not.toHaveBeenCalled();
  });

  it('DELETE は endpoint を SIWE address の購読から削除する', async () => {
    const res = await DELETE(req('DELETE', { endpoint: subscription.endpoint }));

    expect(res.status).toBe(200);
    expect(storeSpy.remove).toHaveBeenCalledWith(SESSION_ADDR, {
      endpoint: subscription.endpoint,
    });
  });

  it('DELETE は保存済み private endpoint も loose parse で解除できる', async () => {
    const endpoint = 'https://127.0.0.1/legacy-push';
    const res = await DELETE(req('DELETE', { endpoint }));

    expect(res.status).toBe(200);
    expect(storeSpy.remove).toHaveBeenCalledWith(SESSION_ADDR, { endpoint });
  });
});

describe('D6: GET /api/push/subscribe', () => {
  // Optional lookup lets the pre-fix suite fail at an assertion rather than module import.
  async function get(hash = createHash('sha256').update(subscription.endpoint).digest('hex')) {
    const handler = (subscribeRoute as unknown as { GET?: (req: Request) => Promise<Response> }).GET;
    expect(handler).toBeTypeOf('function');
    return handler!(new Request(`http://localhost/api/push/subscribe?endpointHash=${hash}`));
  }

  it('returns only this device status/preferences without endpoints or push keys', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ subscribed: true, includeAmount: true });
    expect(storeSpy.list).toHaveBeenCalledWith(SESSION_ADDR);
  });

  it('another device is not reported as this device subscription', async () => {
    const res = await get('a'.repeat(64));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false, includeAmount: false });
  });

  it.each(['', 'not-a-hash', 'a'.repeat(63), 'a'.repeat(65)])('invalid endpoint hash %s is rejected before reading subscriptions', async (hash) => {
    const res = await get(hash);
    expect(res.status).toBe(400);
    expect(storeSpy.list).not.toHaveBeenCalled();
  });

  it.each(['signed-out', 'disabled', 'limited', 'storage-down'])('%s cannot report a successful subscription lookup', async (mode) => {
    if (mode === 'signed-out') hold.session = { ok: false, response: null };
    if (mode === 'disabled') hold.enablePushNotify = false;
    if (mode === 'limited') hold.rateAllowed = false;
    if (mode === 'storage-down') hold.listOk = false;
    const res = await get();
    expect(res.status).toBe({ 'signed-out': 401, disabled: 404, limited: 429, 'storage-down': 503 }[mode]);
    if (mode !== 'storage-down') expect(storeSpy.list).not.toHaveBeenCalled();
  });
});
