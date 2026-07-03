import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

const hold = vi.hoisted(() => ({
  enablePushNotify: true,
  pushVapidPublicKey: 'test-public-key',
  subscriptions: [] as Array<{
    endpointHash: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    locale: 'ja' | 'en';
    vapidKeyId: string;
    createdAt: number;
  }>,
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

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const webPush = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock(
  'web-push',
  () => ({
    default: webPush,
  }),
);

const store = vi.hoisted(() => ({
  list: vi.fn(),
  refresh: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/lib/push/store', () => ({
  listPushSubscriptions: (...args: unknown[]) => {
    store.list(...args);
    return Promise.resolve({ ok: true, value: hold.subscriptions });
  },
  refreshPushSubscriptionsTtl: (...args: unknown[]) => {
    store.refresh(...args);
    return Promise.resolve(true);
  },
  removePushSubscription: (...args: unknown[]) => {
    store.remove(...args);
    return Promise.resolve({ ok: true, value: [] });
  },
}));

import { sendPushToWallet } from '@/lib/push/server';

const keys = { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) };

beforeEach(() => {
  hold.enablePushNotify = true;
  hold.pushVapidPublicKey = 'test-public-key';
  hold.subscriptions = [
    {
      endpointHash: 'a'.repeat(64),
      endpoint: 'https://push.example/sub/a',
      keys,
      locale: 'ja',
      vapidKeyId: '12345678',
      createdAt: 1,
    },
    {
      endpointHash: 'b'.repeat(64),
      endpoint: 'https://push.example/sub/b',
      keys,
      locale: 'en',
      vapidKeyId: '12345678',
      createdAt: 2,
    },
    {
      endpointHash: 'c'.repeat(64),
      endpoint: 'https://push.example/sub/c',
      keys,
      locale: 'ja',
      vapidKeyId: '12345678',
      createdAt: 3,
    },
  ];
  process.env.PUSH_VAPID_PRIVATE_KEY = 'private-key';
  process.env.PUSH_VAPID_SUBJECT = 'mailto:ops@example.com';
  webPush.setVapidDetails.mockReset();
  webPush.sendNotification.mockReset();
  store.list.mockClear();
  store.refresh.mockClear();
  store.remove.mockClear();
});

describe('sendPushToWallet', () => {
  it('flag OFF は inert で送信しない', async () => {
    hold.enablePushNotify = false;

    const summary = await sendPushToWallet(WALLET, {
      title: '着金がありました',
      body: 'OpenPay',
    });

    expect(summary).toEqual({ attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });

  it('Promise.allSettled で全購読を処理し、成功 TTL 更新・410 prune・失敗 no-throw', async () => {
    webPush.sendNotification
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockRejectedValueOnce(new Error('network down'));

    await expect(
      sendPushToWallet(WALLET, {
        title: '着金がありました',
        body: '売上を確認できます',
      }),
    ).resolves.toEqual({ attempted: 3, sent: 1, pruned: 1, failed: 1 });

    expect(webPush.setVapidDetails).toHaveBeenCalledWith(
      'mailto:ops@example.com',
      'test-public-key',
      'private-key',
    );
    expect(webPush.sendNotification).toHaveBeenCalledTimes(3);
    expect(JSON.parse(webPush.sendNotification.mock.calls[0][1])).toMatchObject({
      title: '着金がありました',
      body: '売上を確認できます',
      url: '/ja/history',
    });
    expect(JSON.parse(webPush.sendNotification.mock.calls[1][1])).toMatchObject({
      url: '/en/history',
    });
    expect(store.refresh).toHaveBeenCalledWith(WALLET);
    expect(store.remove).toHaveBeenCalledWith(WALLET, {
      endpointHash: 'b'.repeat(64),
    });
  });

  it('VAPID 未設定でも throw せず送信を skip する', async () => {
    delete process.env.PUSH_VAPID_PRIVATE_KEY;

    const summary = await sendPushToWallet(WALLET, {
      title: '着金がありました',
    });

    expect(summary).toEqual({ attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });
});
