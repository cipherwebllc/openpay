import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const hold = vi.hoisted(() => ({
  enablePushNotify: true,
  data: new Map<string, string>(),
  ttl: new Map<string, number>(),
  incr: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
  send: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    get enablePushNotify() {
      return hold.enablePushNotify;
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: hold.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/kv', () => ({
  kvIncr: (key: string) => {
    hold.incr(key);
    const next = Number.parseInt(hold.data.get(key) ?? '0', 10) + 1;
    hold.data.set(key, String(next));
    return Promise.resolve({ ok: true, value: next });
  },
  kvExpire: (key: string, ttlSec: number) => {
    hold.expire(key, ttlSec);
    hold.ttl.set(key, ttlSec);
    return Promise.resolve({ ok: true, value: 1 });
  },
  kvSet: (
    key: string,
    value: string,
    opts: { nx?: boolean; ttlSec?: number } = {},
  ) => {
    hold.set(key, value, opts);
    if (opts.nx && hold.data.has(key)) {
      return Promise.resolve({ ok: true, value: null });
    }
    hold.data.set(key, value);
    if (opts.ttlSec !== undefined) hold.ttl.set(key, opts.ttlSec);
    return Promise.resolve({ ok: true, value: 'OK' });
  },
  kvEval: (script: string, keys: string[], args: string[]) => {
    hold.eval(script, keys, args);
    const value = hold.data.get(keys[0]) ?? null;
    hold.data.delete(keys[0]);
    return Promise.resolve({ ok: true, value });
  },
}));

vi.mock('@/lib/push/server', () => ({
  sendPushToWallet: (...args: unknown[]) => {
    hold.send(...args);
    return Promise.resolve({ attempted: 1, sent: 1, pruned: 0, failed: 0 });
  },
}));

import {
  PUSH_NOTIFY_COALESCE_TTL_SEC,
  PUSH_NOTIFY_PENDING_TTL_SEC,
  notifyPaymentReceived,
  pushNotifyCoalesceKey,
  pushNotifyPendingKey,
} from '@/lib/push/notify';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const pendingKey = pushNotifyPendingKey(WALLET);
const coalesceKey = pushNotifyCoalesceKey(WALLET);

beforeEach(() => {
  hold.enablePushNotify = true;
  hold.data.clear();
  hold.ttl.clear();
  hold.incr.mockClear();
  hold.expire.mockClear();
  hold.set.mockClear();
  hold.eval.mockClear();
  hold.send.mockClear();
  hold.warn.mockClear();
});

describe('notifyPaymentReceived', () => {
  it('NX 取得時だけ pending を GETDEL して locale 別文言で送信する', async () => {
    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.incr).toHaveBeenCalledWith(pendingKey);
    expect(hold.expire).toHaveBeenCalledWith(
      pendingKey,
      PUSH_NOTIFY_PENDING_TTL_SEC,
    );
    expect(hold.set).toHaveBeenCalledWith(coalesceKey, '1', {
      nx: true,
      ttlSec: PUSH_NOTIFY_COALESCE_TTL_SEC,
    });
    expect(hold.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = hold.eval.mock.calls[0] as [
      string,
      string[],
      string[],
    ];
    expect(script).toContain("redis.call('GET', KEYS[1])");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect(keys).toEqual([pendingKey]);
    expect(args).toEqual([]);
    expect(hold.data.has(pendingKey)).toBe(false);

    expect(hold.send).toHaveBeenCalledTimes(1);
    const [, payload] = hold.send.mock.calls[0] as [
      string,
      (locale: 'ja' | 'en') => { title: string },
    ];
    expect(payload('ja')).toEqual({ title: '着金がありました' });
    expect(payload('en')).toEqual({ title: 'Payment received' });
  });

  it('NX 不取得時は pending count だけ増やして送信しない', async () => {
    hold.data.set(coalesceKey, '1');

    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.data.get(pendingKey)).toBe('1');
    expect(hold.eval).not.toHaveBeenCalled();
    expect(hold.send).not.toHaveBeenCalled();
  });

  it('次の NX 取得時に pending を atomic GETDEL し n 件文言で集約する', async () => {
    hold.data.set(pendingKey, '2');

    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.data.has(pendingKey)).toBe(false);
    expect(hold.send).toHaveBeenCalledTimes(1);
    const [, payload] = hold.send.mock.calls[0] as [
      string,
      (locale: 'ja' | 'en') => { title: string },
    ];
    expect(payload('ja')).toEqual({ title: '新着 3 件の着金があります' });
    expect(payload('en')).toEqual({ title: '3 new payments received' });
  });

  it('注文通知は指定の locale 別文言を使う', async () => {
    await notifyPaymentReceived(WALLET, 'order');

    const [, payload] = hold.send.mock.calls[0] as [
      string,
      (locale: 'ja' | 'en') => { title: string },
    ];
    expect(payload('ja')).toEqual({ title: '新しい注文があります' });
    expect(payload('en')).toEqual({ title: 'New order received' });
  });

  it('注文通知も複数件は count だけを集約して通知する', async () => {
    hold.data.set(pendingKey, '4');

    await notifyPaymentReceived(WALLET, 'order');

    const [, payload] = hold.send.mock.calls[0] as [
      string,
      (locale: 'ja' | 'en') => { title: string },
    ];
    expect(payload('ja')).toEqual({ title: '新着 5 件の注文があります' });
    expect(payload('en')).toEqual({ title: '5 new orders received' });
  });
});
