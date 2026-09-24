// R6a: run the real KV transport to pin the push storage wire contract.
// B-R6c: the pending consume moved from a Lua EVAL (GET+DEL) to native GETDEL; every other
// command, key, TTL, failure isolation and coalescing expectation is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({ enabled: true, send: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { get enablePushNotify() { return hold.enabled; } } }));
vi.mock('@/lib/push/server', () => ({ sendPushToWallet: hold.send }));
vi.mock('@/lib/logger', () => ({ logger: { warn: hold.warn } }));

import { kvGetDel } from '@/lib/kv';
import { notifyPaymentReceived } from '@/lib/push/notify';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const NORMALIZED = '0x52d4901142e2b5680027da5eb47c86cb02a3ca81';
const data = new Map<string, string>();
const expiry = new Map<string, number>();
let now = 0;
let failure: { command: string; mode: 'http' | 'network' | 'parse' | 'timeout' } | undefined;
let pendingReply: string | null | undefined;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  hold.enabled = true;
  hold.send.mockResolvedValue({ attempted: 1, sent: 1, pruned: 0, failed: 0 });
  data.clear();
  expiry.clear();
  now = 0;
  failure = undefined;
  pendingReply = undefined;
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://r6a-kv.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'r6a-test-token');
  vi.stubEnv('KV_REST_API_URL', '');
  vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const [command, ...args] = JSON.parse(String(init.body)) as string[];
    if (failure?.command === command) {
      if (failure.mode === 'network') throw new Error('offline');
      if (failure.mode === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (failure.mode === 'parse') return new Response('{');
      return new Response('{"error":"unavailable"}', { status: 503 });
    }
    for (const [key, expiresAt] of expiry) {
      if (expiresAt <= now) { data.delete(key); expiry.delete(key); }
    }
    let result: string | number | null;
    const key = args[0];
    if (command === 'INCR') {
      result = Number(data.get(key) ?? 0) + 1;
      data.set(key, String(result));
    } else if (command === 'EXPIRE') {
      expiry.set(key, now + Number(args[1]));
      result = 1;
    } else if (command === 'SET') {
      result = data.has(key) ? null : 'OK';
      if (result !== null) {
        data.set(key, args[1]);
        expiry.set(key, now + Number(args[3]));
      }
    } else if (command === 'GETDEL') {
      // EVAL is intentionally unhandled: any leftover Lua consume fails as an unexpected command.
      result = pendingReply === undefined ? data.get(key) ?? null : pendingReply;
      data.delete(key);
    } else {
      throw new Error(`unexpected command: ${command}`);
    }
    return new Response(JSON.stringify({ result }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function commands(): string[][] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as string[]);
}

function payload(locale: 'ja' | 'en', includeAmount = false, call = 0) {
  return hold.send.mock.calls[call][1](locale, { includeAmount });
}

describe('R6a push storage contract', () => {
  it.each(['payment', 'order', 'store'] as const)('pins %s keys, value, TTLs and the native GETDEL consume', async (kind) => {
    await notifyPaymentReceived(WALLET, kind);
    const pending = `push:pending:${NORMALIZED}:${kind}`;
    const coalesce = `push:coalesce:${NORMALIZED}:${kind}`;
    const expected = [
      ['INCR', pending],
      ['EXPIRE', pending, '86400'],
      ['SET', coalesce, '1', 'EX', '60', 'NX'],
      ['GETDEL', pending],
    ];
    // Compare raw REST bodies as well as parsed commands.
    expect(fetchMock.mock.calls.map(([, init]) => init.body)).toEqual(expected.map((cmd) => JSON.stringify(cmd)));
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://r6a-kv.test/');
      expect(init).toMatchObject({
        method: 'POST', cache: 'no-store',
        headers: { Authorization: 'Bearer r6a-test-token', 'content-type': 'application/json' },
      });
    }
    expect(data.has(pending)).toBe(false);
    expect(data.get(coalesce)).toBe('1');
    expect(hold.send).toHaveBeenCalledTimes(1);
    expect(hold.send.mock.calls[0][0]).toBe(WALLET);
  });

  // B-R6c: kvGetDel returns the same KvResult the Lua GET+DEL did (value, then null once
  // consumed), and the push path now sends only GETDEL for the consume, never EVAL.
  it('kvGetDel returns the value then null, and the push path never sends EVAL', async () => {
    const key = `push:pending:${NORMALIZED}:payment`;
    data.set(key, '2');
    expect(await kvGetDel(key)).toEqual({ ok: true, value: '2' });
    expect(await kvGetDel(key)).toEqual({ ok: true, value: null });
    expect(fetchMock.mock.calls.map(([, init]) => init.body)).toEqual([
      `["GETDEL","${key}"]`,
      `["GETDEL","${key}"]`,
    ]);
    fetchMock.mockClear();
    await notifyPaymentReceived(WALLET, 'payment');
    now = 60;
    await notifyPaymentReceived(WALLET, 'order');
    expect(commands().map(([cmd]) => cmd)).not.toContain('EVAL');
    expect(commands().filter(([cmd]) => cmd === 'GETDEL')).toHaveLength(2);
  });

  it('coalesces through second 59, consumes at second 60, and hides amounts for the combined count', async () => {
    await notifyPaymentReceived(WALLET, 'payment', '¥1,000');
    expect(payload('ja', true)).toEqual({ title: '¥1,000 の着金がありました' });
    expect(payload('en')).toEqual({ title: 'Payment received' });
    now = 59;
    await notifyPaymentReceived(WALLET, 'payment', '¥2,000');
    expect(hold.send).toHaveBeenCalledTimes(1);
    expect(commands().filter(([cmd]) => cmd === 'GETDEL')).toHaveLength(1);
    now = 60;
    await notifyPaymentReceived(WALLET, 'payment', '¥3,000');
    expect(hold.send).toHaveBeenCalledTimes(2);
    expect(payload('ja', true, 1)).toEqual({ title: '前回通知以降の着金: 2 件' });
    expect(payload('en', true, 1)).toEqual({ title: '2 payments since last notice' });
    expect(commands().filter(([cmd]) => cmd === 'GETDEL')).toHaveLength(2);
  });

  it.each([
    { elapsed: 86399, title: '2 payments since last notice' },
    { elapsed: 86400, title: 'Payment received' },
  ])('keeps trailing counts for exactly 24 hours ($elapsed seconds)', async ({ elapsed, title }) => {
    await notifyPaymentReceived(WALLET, 'payment');
    now = 30;
    await notifyPaymentReceived(WALLET, 'payment');
    now += elapsed;
    expect(hold.send).toHaveBeenCalledTimes(1); // No scheduled trailing send.
    await notifyPaymentReceived(WALLET, 'payment');
    expect(payload('en', false, 1)).toEqual({ title });
  });

  it.each([
    { raw: null, title: 'Payment received' },
    { raw: '', title: 'Payment received' },
    { raw: 'garbage', title: 'Payment received' },
    { raw: '0', title: 'Payment received' },
    { raw: '-2', title: 'Payment received' },
    { raw: '3 trailing', title: '3 payments since last notice' },
  ])('preserves pending-count parsing for $raw', async ({ raw, title }) => {
    pendingReply = raw;
    await notifyPaymentReceived(WALLET, 'payment');
    expect(payload('en')).toEqual({ title });
  });

  it.each([
    { command: 'INCR', event: 'push.notify_pending_incr_failed', trace: ['INCR'], sent: 0 },
    { command: 'EXPIRE', event: 'push.notify_pending_ttl_failed', trace: ['INCR', 'EXPIRE', 'SET', 'GETDEL'], sent: 1 },
    { command: 'SET', event: 'push.notify_coalesce_claim_failed', trace: ['INCR', 'EXPIRE', 'SET'], sent: 0 },
    { command: 'GETDEL', event: 'push.notify_pending_getdel_failed', trace: ['INCR', 'EXPIRE', 'SET', 'GETDEL'], sent: 0 },
  ])('preserves $command failure isolation and continuation', async ({ command, event, trace, sent }) => {
    failure = { command, mode: 'http' };
    await expect(notifyPaymentReceived(WALLET, 'payment')).resolves.toBeUndefined();
    expect(commands().map(([cmd]) => cmd)).toEqual(trace);
    expect(hold.send).toHaveBeenCalledTimes(sent);
    expect(hold.warn).toHaveBeenCalledWith(event, { wallet: NORMALIZED, kind: 'payment', reason: 'http_error' });
  });

  it.each([
    { mode: 'network', reason: 'network_error' },
    { mode: 'parse', reason: 'parse_error' },
    { mode: 'timeout', reason: 'timeout' },
  ] as const)('keeps pending/coalesce state after GETDEL $mode failure', async ({ mode, reason }) => {
    failure = { command: 'GETDEL', mode };
    await expect(notifyPaymentReceived(WALLET, 'payment')).resolves.toBeUndefined();
    expect(hold.send).not.toHaveBeenCalled();
    expect(data.get(`push:pending:${NORMALIZED}:payment`)).toBe('1');
    expect(data.get(`push:coalesce:${NORMALIZED}:payment`)).toBe('1');
    expect(hold.warn).toHaveBeenCalledWith('push.notify_pending_getdel_failed', { wallet: NORMALIZED, kind: 'payment', reason });
    failure = undefined;
    now = 60;
    await notifyPaymentReceived(WALLET, 'payment');
    expect(payload('en')).toEqual({ title: '2 payments since last notice' });
  });

  it('does no I/O when disabled', async () => {
    hold.enabled = false;
    await notifyPaymentReceived(WALLET, 'payment');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hold.send).not.toHaveBeenCalled();
  });

  it('isolates missing KV credentials without sending', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
    await expect(notifyPaymentReceived(WALLET, 'payment')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hold.send).not.toHaveBeenCalled();
    expect(hold.warn).toHaveBeenCalledWith('push.notify_pending_incr_failed', {
      wallet: NORMALIZED, kind: 'payment', reason: 'unconfigured',
    });
  });

  it('retains the catch isolating a rejected push sender after the pending count was consumed', async () => {
    hold.send.mockRejectedValue(new Error('push unavailable'));
    await expect(notifyPaymentReceived(WALLET, 'payment')).resolves.toBeUndefined();
    expect(data.has(`push:pending:${NORMALIZED}:payment`)).toBe(false);
    expect(data.get(`push:coalesce:${NORMALIZED}:payment`)).toBe('1');
    expect(hold.warn).toHaveBeenCalledWith('push.notify_failed', {
      wallet: NORMALIZED, kind: 'payment', detail: 'push unavailable',
    });
  });
});
