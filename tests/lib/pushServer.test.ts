import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';

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
    includeAmount?: boolean;
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

import { createPushHttpsAgent, sendPushToWallet } from '@/lib/push/server';
import { logger } from '@/lib/logger';

const keys = { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) };

type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

async function agentLookup(agent: HttpsAgent, hostname: string): Promise<unknown> {
  const lookup = agent.options.lookup;
  if (!lookup) throw new Error('lookup hook missing');
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

beforeEach(() => {
  hold.enablePushNotify = true;
  hold.pushVapidPublicKey = 'test-public-key';
  hold.subscriptions = [
    {
      endpointHash: 'a'.repeat(64),
      endpoint: 'https://fcm.googleapis.com/sub/a',
      keys,
      locale: 'ja',
      vapidKeyId: '12345678',
      createdAt: 1,
    },
    {
      endpointHash: 'b'.repeat(64),
      endpoint: 'https://fcm.googleapis.com/sub/b',
      keys,
      locale: 'en',
      vapidKeyId: '12345678',
      createdAt: 2,
    },
    {
      endpointHash: 'c'.repeat(64),
      endpoint: 'https://fcm.googleapis.com/sub/c',
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
    expect(webPush.sendNotification.mock.calls[0][2]).toEqual({
      agent: expect.any(HttpsAgent),
      timeout: 3_500,
    });
    expect(JSON.parse(webPush.sendNotification.mock.calls[0][1])).toMatchObject({
      title: '着金がありました',
      body: '売上を確認できます',
      url: '/ja/history?from=push',
    });
    expect(JSON.parse(webPush.sendNotification.mock.calls[1][1])).toMatchObject({
      url: '/en/history?from=push',
    });
    expect(store.refresh).toHaveBeenCalledWith(WALLET);
    expect(store.remove).toHaveBeenCalledWith(WALLET, {
      endpointHash: 'b'.repeat(64),
    });
  });

  it('関数 resolver は (locale, sub) を受け購読ごとに payload を出し分ける', async () => {
    hold.subscriptions = [
      {
        endpointHash: 'a'.repeat(64),
        endpoint: 'https://fcm.googleapis.com/opt-in',
        keys,
        locale: 'ja',
        vapidKeyId: '12345678',
        includeAmount: true,
        createdAt: 1,
      },
      {
        endpointHash: 'b'.repeat(64),
        endpoint: 'https://fcm.googleapis.com/opt-out',
        keys,
        locale: 'ja',
        vapidKeyId: '12345678',
        includeAmount: false,
        createdAt: 2,
      },
    ];
    webPush.sendNotification.mockResolvedValue(undefined);

    await sendPushToWallet(WALLET, (locale, sub) => ({
      title:
        sub.includeAmount && locale === 'ja' ? '¥1 の着金' : '着金がありました',
    }));

    expect(JSON.parse(webPush.sendNotification.mock.calls[0][1])).toMatchObject({
      title: '¥1 の着金',
    });
    expect(JSON.parse(webPush.sendNotification.mock.calls[1][1])).toMatchObject({
      title: '着金がありました',
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

  it('skips legacy public hosts without pruning, sends valid siblings, and logs once per process', async () => {
    vi.resetModules();
    const { sendPushToWallet: send } = await import('@/lib/push/server');
    vi.mocked(logger.warn).mockClear();
    hold.subscriptions[0].endpoint = 'https://example.com/private-token';
    hold.subscriptions[1].endpoint = 'https://another.example/private-token';
    webPush.sendNotification.mockResolvedValue(undefined);
    const payload = vi.fn(() => ({ title: 'payment received' }));

    for (let i = 0; i < 2; i += 1) {
      await expect(send(WALLET, payload)).resolves.toEqual({
        attempted: 3, sent: 1, pruned: 0, failed: 2,
      });
    }
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: hold.subscriptions[2].endpoint }),
      expect.any(String), expect.any(Object),
    );
    expect(payload).toHaveBeenCalledTimes(2);
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.refresh).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('push.send_blocked_endpoint');
  });

  it.each([
    'https://evil.example%2eweb.push.apple.com/token',
    'https://127.0.0.1%2eweb.push.apple.com/token',
    'https://%66cm.googleapis.com/token',
  ])('passes the validated URL serialization to web-push: %s', async (endpoint) => {
    hold.subscriptions = [{ ...hold.subscriptions[0], endpoint }];
    webPush.sendNotification.mockResolvedValue(undefined);
    await expect(sendPushToWallet(WALLET, { title: 'received' })).resolves.toEqual({
      attempted: 1, sent: 1, pruned: 0, failed: 0,
    });
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: new URL(endpoint).href }),
      expect.any(String), expect.any(Object),
    );
  });

  it.each([
    'https://example.com/push',
    'https://web.push.apple.com.evil.example/push',
    'https://evilnotify.windows.com/push',
    'https://updates.push.services.mozilla.com.evil.example/push',
    'http://fcm.googleapis.com/push',
    'https://user:pass@fcm.googleapis.com/push',
    'https://fcm.googleapis.com:8443/push',
  ])('revalidates stored endpoints at the send sink: %s', async (endpoint) => {
    hold.subscriptions = [{ ...hold.subscriptions[0], endpoint }];
    await expect(sendPushToWallet(WALLET, { title: 'received' })).resolves.toEqual({
      attempted: 1, sent: 0, pruned: 0, failed: 1,
    });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(store.refresh).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it.each([
    '100.64.0.1', '192.0.0.1', '198.18.0.1', '203.0.113.1',
    '224.0.0.1', '240.0.0.1', '::ffff:198.18.0.1',
    '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'fec0::1', 'ff02::1',
  ])('connect-time lookup blocks a special-purpose answer: %s', async (address) => {
    const lookupAll: LookupAll = (_hostname, _options, callback) => callback(null, [
      { address: '8.8.8.8', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 },
    ]);
    const agent = createPushHttpsAgent(lookupAll);
    try {
      await expect(agentLookup(agent, 'fcm.googleapis.com')).rejects.toThrow(
        'push_blocked_private_address',
      );
    } finally {
      agent.destroy();
    }
  });

  it('保存済み literal private endpoint は sink で再拒否し、購読は削除しない', async () => {
    hold.subscriptions = [
      {
        endpointHash: 'a'.repeat(64),
        endpoint: 'https://127.0.0.1/push',
        keys,
        locale: 'ja',
        vapidKeyId: '12345678',
        createdAt: 1,
      },
    ];

    await expect(
      sendPushToWallet(WALLET, { title: '着金がありました' }),
    ).resolves.toEqual({ attempted: 1, sent: 0, pruned: 0, failed: 1 });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('connect-time lookup は A/AAAA に private が 1 件でも混ざれば拒否する', async () => {
    const lookupAll: LookupAll = (_hostname, _options, callback) => {
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
    };
    const agent = createPushHttpsAgent(lookupAll);

    await expect(agentLookup(agent, 'push.example')).rejects.toThrow(
      'push_blocked_private_address',
    );
  });

  it.each(['empty', 'dns-error'] as const)(
    'connect-time lookup は %s を fail-closed にする',
    async (mode) => {
      const lookupAll: LookupAll = (_hostname, _options, callback) => {
        if (mode === 'empty') callback(null, []);
        else callback(new Error('ENOTFOUND'), []);
      };
      const agent = createPushHttpsAgent(lookupAll);
      await expect(agentLookup(agent, 'push.example')).rejects.toThrow();
    },
  );

  it('connect-time lookup は全件 public の A/AAAA だけを返す', async () => {
    const addresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    const lookupAll: LookupAll = (_hostname, _options, callback) => {
      callback(null, addresses);
    };
    const agent = createPushHttpsAgent(lookupAll);

    await expect(agentLookup(agent, 'push.example')).resolves.toEqual(addresses);
  });
});
