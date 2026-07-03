import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('server-only', () => ({}));

const kv = vi.hoisted(() => ({
  data: new Map<string, string>(),
  ttl: new Map<string, number>(),
  evalSpy: vi.fn(),
  getSpy: vi.fn(),
  expireSpy: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    pushVapidPublicKey: 'test-public-key',
  },
}));

vi.mock('@/lib/kv', () => ({
  kvGet: (key: string) => {
    kv.getSpy(key);
    return Promise.resolve({ ok: true, value: kv.data.get(key) ?? null });
  },
  kvExpire: (key: string, ttlSec: number) => {
    kv.expireSpy(key, ttlSec);
    if (!kv.data.has(key)) return Promise.resolve({ ok: true, value: 0 });
    kv.ttl.set(key, ttlSec);
    return Promise.resolve({ ok: true, value: 1 });
  },
  kvEval: (_script: string, keys: string[], args: string[]) => {
    kv.evalSpy(_script, keys, args);
    const key = keys[0];
    if (args.length === 10) {
      const [
        endpointHash,
        endpoint,
        p256dh,
        auth,
        locale,
        vapidKeyId,
        createdAtRaw,
        ttlRaw,
        capRaw,
        includeAmountRaw,
      ] = args;
      const list = JSON.parse(kv.data.get(key) ?? '[]') as Array<{
        endpointHash: string;
        endpoint: string;
        keys: { p256dh: string; auth: string };
        locale: string;
        vapidKeyId: string;
        includeAmount: boolean;
        createdAt: number;
      }>;
      const next = {
        endpointHash,
        endpoint,
        keys: { p256dh, auth },
        locale,
        vapidKeyId,
        includeAmount: includeAmountRaw === '1',
        createdAt: Number(createdAtRaw),
      };
      const idx = list.findIndex((item) => item.endpointHash === endpointHash);
      if (idx >= 0) list[idx] = next;
      else list.push(next);
      list.sort((a, b) => a.createdAt - b.createdAt);
      while (list.length > Number(capRaw)) list.shift();
      const raw = JSON.stringify(list);
      kv.data.set(key, raw);
      kv.ttl.set(key, Number(ttlRaw));
      return Promise.resolve({ ok: true, value: raw });
    }

    const [endpointHash, ttlRaw] = args;
    const list = (JSON.parse(kv.data.get(key) ?? '[]') as Array<{
      endpointHash: string;
    }>).filter((item) => item.endpointHash !== endpointHash);
    const raw = JSON.stringify(list);
    if (list.length === 0) kv.data.delete(key);
    else {
      kv.data.set(key, raw);
      kv.ttl.set(key, Number(ttlRaw));
    }
    return Promise.resolve({ ok: true, value: raw });
  },
}));

import {
  PUSH_SUBSCRIPTION_CAP,
  PUSH_SUBSCRIPTION_TTL_SEC,
  endpointHash,
  listPushSubscriptions,
  pushSubscriptionKey,
  pushVapidKeyId,
  refreshPushSubscriptionsTtl,
  removePushSubscription,
  upsertPushSubscription,
} from '@/lib/push/store';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const key = pushSubscriptionKey(WALLET);
const keys = { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) };

beforeEach(() => {
  kv.data.clear();
  kv.ttl.clear();
  kv.evalSpy.mockClear();
  kv.getSpy.mockClear();
  kv.expireSpy.mockClear();
});

describe('push subscription store', () => {
  it('upsert は endpointHash / vapidKeyId を付与し TTL 90日で保存する', async () => {
    const res = await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/1',
      keys,
      locale: 'ja',
      nowMs: 100,
    });

    expect(res.ok).toBe(true);
    expect(res.ok && res.value[0]).toMatchObject({
      endpointHash: endpointHash('https://push.example/sub/1'),
      endpoint: 'https://push.example/sub/1',
      keys,
      locale: 'ja',
      vapidKeyId: pushVapidKeyId('test-public-key'),
      createdAt: 100,
    });
    expect(kv.ttl.get(key)).toBe(PUSH_SUBSCRIPTION_TTL_SEC);
    const [, keysArg, args] = kv.evalSpy.mock.calls[0] as [
      string,
      string[],
      string[],
    ];
    expect(keysArg).toEqual([key]);
    expect(args[8]).toBe(String(PUSH_SUBSCRIPTION_CAP));
  });

  it('同一 endpointHash は置換し、台数を増やさない', async () => {
    await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/1',
      keys,
      locale: 'ja',
      nowMs: 100,
    });
    await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/1',
      keys: { p256dh: 'C'.repeat(87), auth: 'D'.repeat(22) },
      locale: 'en',
      nowMs: 200,
    });

    const listed = await listPushSubscriptions(WALLET);
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(listed.ok && listed.value[0]).toMatchObject({
      keys: { p256dh: 'C'.repeat(87), auth: 'D'.repeat(22) },
      locale: 'en',
      createdAt: 200,
    });
  });

  it('cap 5 台を超えると oldest createdAt を prune する', async () => {
    for (let i = 1; i <= 6; i += 1) {
      await upsertPushSubscription(WALLET, {
        endpoint: `https://push.example/sub/${i}`,
        keys,
        locale: i % 2 === 0 ? 'en' : 'ja',
        nowMs: i,
      });
    }

    const listed = await listPushSubscriptions(WALLET);
    expect(listed.ok && listed.value).toHaveLength(5);
    expect(listed.ok && listed.value.map((sub) => sub.createdAt)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  it('remove は endpoint から hash を計算して prune し、残り key の TTL を再設定する', async () => {
    await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/1',
      keys,
      locale: 'ja',
      nowMs: 1,
    });
    await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/2',
      keys,
      locale: 'en',
      nowMs: 2,
    });

    const res = await removePushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/1',
    });

    expect(res.ok && res.value.map((sub) => sub.endpoint)).toEqual([
      'https://push.example/sub/2',
    ]);
    expect(kv.ttl.get(key)).toBe(PUSH_SUBSCRIPTION_TTL_SEC);
    const [, , args] = kv.evalSpy.mock.calls.at(-1) as [
      string,
      string[],
      string[],
    ];
    expect(args[0]).toBe(
      createHash('sha256').update('https://push.example/sub/1').digest('hex'),
    );
  });

  it('送信成功時の TTL refresh は push key に EXPIRE 90日を打つ', async () => {
    await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/1',
      keys,
      locale: 'ja',
      nowMs: 1,
    });

    await expect(refreshPushSubscriptionsTtl(WALLET)).resolves.toBe(true);
    expect(kv.expireSpy).toHaveBeenCalledWith(key, PUSH_SUBSCRIPTION_TTL_SEC);
  });

  it('includeAmount opt-in を保存し round-trip する (既定は false)', async () => {
    await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/off',
      keys,
      locale: 'ja',
      nowMs: 1,
    });
    await upsertPushSubscription(WALLET, {
      endpoint: 'https://push.example/sub/on',
      keys,
      locale: 'en',
      includeAmount: true,
      nowMs: 2,
    });

    const listed = await listPushSubscriptions(WALLET);
    expect(listed.ok).toBe(true);
    const byEndpoint = Object.fromEntries(
      (listed.ok ? listed.value : []).map((s) => [s.endpoint, s.includeAmount]),
    );
    expect(byEndpoint['https://push.example/sub/off']).toBe(false);
    expect(byEndpoint['https://push.example/sub/on']).toBe(true);
    // ARGV[10] に includeAmount フラグを渡している。
    const args = kv.evalSpy.mock.calls[1][2] as string[];
    expect(args[9]).toBe('1');
  });
});

// validator (isStoredPushSubscription・listPushSubscriptions 経由) の後方互換。
// 2a 保存済みレコードは includeAmount を持たない → reject してはならない。boolean 以外は reject。
describe('push subscription validator: includeAmount 後方互換', () => {
  it('includeAmount 欠落レコードを受理する (undefined→後段で false 扱い)', async () => {
    kv.data.set(
      key,
      JSON.stringify([
        {
          endpointHash: 'a'.repeat(64),
          endpoint: 'https://push.example/legacy',
          keys,
          locale: 'ja',
          vapidKeyId: '12345678',
          createdAt: 1,
          // includeAmount 欠落 (2a レコード)
        },
      ]),
    );

    const listed = await listPushSubscriptions(WALLET);
    expect(listed.ok).toBe(true);
    expect(listed.ok && listed.value).toHaveLength(1);
    expect(listed.ok && listed.value[0].includeAmount).toBeUndefined();
  });

  it('includeAmount が boolean でないレコードは reject (parse_error)', async () => {
    kv.data.set(
      key,
      JSON.stringify([
        {
          endpointHash: 'a'.repeat(64),
          endpoint: 'https://push.example/bad',
          keys,
          locale: 'ja',
          vapidKeyId: '12345678',
          createdAt: 1,
          includeAmount: 'yes',
        },
      ]),
    );

    const listed = await listPushSubscriptions(WALLET);
    expect(listed.ok).toBe(false);
    expect(!listed.ok && listed.reason).toBe('parse_error');
  });
});
