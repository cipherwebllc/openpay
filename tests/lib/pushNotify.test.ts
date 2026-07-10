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
const paymentPendingKey = pushNotifyPendingKey(WALLET, 'payment');
const paymentCoalesceKey = pushNotifyCoalesceKey(WALLET, 'payment');
const orderPendingKey = pushNotifyPendingKey(WALLET, 'order');
const orderCoalesceKey = pushNotifyCoalesceKey(WALLET, 'order');

type Sub = {
  endpointHash: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale: 'ja' | 'en';
  vapidKeyId: string;
  includeAmount?: boolean;
  createdAt: number;
};
type Resolver = (locale: 'ja' | 'en', sub: Sub) => { title: string };

function sub(includeAmount = false, locale: 'ja' | 'en' = 'ja'): Sub {
  return {
    endpointHash: 'a'.repeat(64),
    endpoint: 'https://push.example/sub',
    keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    locale,
    vapidKeyId: '12345678',
    includeAmount,
    createdAt: 1,
  };
}

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
  it('pending と coalesce のキーを wallet と kind ごとに分離する', () => {
    const normalizedWallet = WALLET.toLowerCase();

    expect(paymentPendingKey).toBe(`push:pending:${normalizedWallet}:payment`);
    expect(orderPendingKey).toBe(`push:pending:${normalizedWallet}:order`);
    expect(paymentCoalesceKey).toBe(
      `push:coalesce:${normalizedWallet}:payment`,
    );
    expect(orderCoalesceKey).toBe(`push:coalesce:${normalizedWallet}:order`);
  });

  it('NX 取得時だけ pending を GETDEL して locale 別文言で送信する', async () => {
    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.incr).toHaveBeenCalledWith(paymentPendingKey);
    expect(hold.expire).toHaveBeenCalledWith(
      paymentPendingKey,
      PUSH_NOTIFY_PENDING_TTL_SEC,
    );
    expect(hold.set).toHaveBeenCalledWith(paymentCoalesceKey, '1', {
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
    expect(keys).toEqual([paymentPendingKey]);
    expect(args).toEqual([]);
    expect(hold.data.has(paymentPendingKey)).toBe(false);

    expect(hold.send).toHaveBeenCalledTimes(1);
    const [, payload] = hold.send.mock.calls[0] as [string, Resolver];
    expect(payload('ja', sub())).toEqual({ title: '着金がありました' });
    expect(payload('en', sub(false, 'en'))).toEqual({ title: 'Payment received' });
  });

  it('NX 不取得時は pending count だけ増やして送信しない', async () => {
    hold.data.set(paymentCoalesceKey, '1');

    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.data.get(paymentPendingKey)).toBe('1');
    expect(hold.eval).not.toHaveBeenCalled();
    expect(hold.send).not.toHaveBeenCalled();
  });

  it('同一 kind の連続通知は従来どおり coalesce する', async () => {
    await notifyPaymentReceived(WALLET, 'payment');
    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.send).toHaveBeenCalledTimes(1);
    expect(hold.eval).toHaveBeenCalledTimes(1);
    expect(hold.data.get(paymentPendingKey)).toBe('1');
  });

  it('payment の pending を order が回収せず kind ごとに通知する', async () => {
    hold.data.set(paymentCoalesceKey, '1');

    await notifyPaymentReceived(WALLET, 'payment');
    await notifyPaymentReceived(WALLET, 'order');

    expect(hold.data.get(paymentPendingKey)).toBe('1');
    expect(hold.data.has(orderPendingKey)).toBe(false);
    expect(hold.eval).toHaveBeenCalledTimes(1);
    expect(hold.eval.mock.calls[0]?.[1]).toEqual([orderPendingKey]);
    expect(hold.send).toHaveBeenCalledTimes(1);
    const [, orderPayload] = hold.send.mock.calls[0] as [string, Resolver];
    expect(orderPayload('ja', sub())).toEqual({
      title: '新しい注文があります',
    });

    hold.data.delete(paymentCoalesceKey);
    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.send).toHaveBeenCalledTimes(2);
    const [, paymentPayload] = hold.send.mock.calls[1] as [string, Resolver];
    expect(paymentPayload('ja', sub())).toEqual({
      title: '新着 2 件の着金があります',
    });
  });

  it('次の NX 取得時に pending を atomic GETDEL し n 件文言で集約する', async () => {
    hold.data.set(paymentPendingKey, '2');

    await notifyPaymentReceived(WALLET, 'payment');

    expect(hold.data.has(paymentPendingKey)).toBe(false);
    expect(hold.send).toHaveBeenCalledTimes(1);
    const [, payload] = hold.send.mock.calls[0] as [string, Resolver];
    expect(payload('ja', sub())).toEqual({ title: '新着 3 件の着金があります' });
    expect(payload('en', sub(false, 'en'))).toEqual({
      title: '3 new payments received',
    });
  });

  it('注文通知は指定の locale 別文言を使う', async () => {
    await notifyPaymentReceived(WALLET, 'order');

    const [, payload] = hold.send.mock.calls[0] as [string, Resolver];
    expect(payload('ja', sub())).toEqual({ title: '新しい注文があります' });
    expect(payload('en', sub(false, 'en'))).toEqual({
      title: 'New order received',
    });
  });

  it('注文通知も複数件は count だけを集約して通知する', async () => {
    hold.data.set(orderPendingKey, '4');

    await notifyPaymentReceived(WALLET, 'order');

    const [, payload] = hold.send.mock.calls[0] as [string, Resolver];
    expect(payload('ja', sub())).toEqual({ title: '新着 5 件の注文があります' });
    expect(payload('en', sub(false, 'en'))).toEqual({
      title: '5 new orders received',
    });
  });

  it('単一 payment は opt-in 購読 (includeAmount) にだけ金額を出す', async () => {
    await notifyPaymentReceived(WALLET, 'payment', '¥1,234');

    const [, payload] = hold.send.mock.calls[0] as [string, Resolver];
    // opt-in 購読は金額入り。
    expect(payload('ja', sub(true))).toEqual({
      title: '¥1,234 の着金がありました',
    });
    expect(payload('en', sub(true, 'en'))).toEqual({
      title: 'Payment received: ¥1,234',
    });
    // 非 opt-in 購読は金額なし (同一送信内でも購読ごとに出し分け)。
    expect(payload('ja', sub(false))).toEqual({ title: '着金がありました' });
  });

  it('複数件 (n>=2) は opt-in でも件数のみ・金額は出さない', async () => {
    hold.data.set(paymentPendingKey, '2');

    await notifyPaymentReceived(WALLET, 'payment', '¥5,000');

    const [, payload] = hold.send.mock.calls[0] as [string, Resolver];
    expect(payload('ja', sub(true))).toEqual({
      title: '新着 3 件の着金があります',
    });
    expect(payload('en', sub(true, 'en'))).toEqual({
      title: '3 new payments received',
    });
  });
});
