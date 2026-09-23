// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex } from 'viem';
import {
  closeRedisLuaEngine,
  createFakeRedisStore,
  runRedisLua,
  type FakeRedisStore,
} from '../../_helpers/redisLua';

const h = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  calls: [] as { script: string; keys: string[]; args: string[] }[],
}));
vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(),
  kvEval: async (script: string, keys: string[], args: string[]) => {
    h.calls.push({ script, keys, args });
    return { ok: true, value: await runRedisLua(script, keys, args, h.store!) };
  },
}));
vi.mock('@/lib/chains', () => ({ chainObjectForId: vi.fn(), transportForChain: vi.fn() }));
vi.mock('@/lib/x402/hostedStore', () => ({ hostedContentKey: vi.fn() }));
vi.mock('@/lib/x402/facilitatorSettle', () => ({ parseFacilitatorRequest: vi.fn() }));
vi.mock('@/lib/x402/paymentRedelivery', () => ({ paymentRedeliveryIdentity: vi.fn() }));

import {
  checkPurchaseQuoteRateLimit,
  PURCHASE_QUOTE_IP_MAX,
  PURCHASE_QUOTE_RATE_WINDOW_SEC,
  PURCHASE_QUOTE_RESOURCE_MAX,
  PURCHASE_QUOTE_WALLET_MAX,
} from '@/lib/x402/purchaseIntent';

const RESOURCE = 'h_' + 'a'.repeat(32);
const IP = 'a'.repeat(64);
const ipKey = (ip = IP) => 'store:quote:rl:ip:' + ip;
const walletKey = (payer: string) => 'store:quote:rl:wallet:' + payer.toLowerCase();
const resourceKey = 'store:quote:rl:resource:' + RESOURCE;
const payer = (n: number) => toHex(n, { size: 20 });
const quote = (n = 1, ipHash: string | null = IP) =>
  checkPurchaseQuoteRateLimit({ payer: payer(n), resourceId: RESOURCE, ipHash });

beforeEach(() => {
  h.store = createFakeRedisStore();
  h.calls = [];
});
afterAll(closeRedisLuaEngine);

describe('hosted quote limiter: production Lua and KEYS/ARGV', () => {
  it.each([null, IP])('allows 12 wallet requests and denies the 13th (ipHash=%s)', async (ipHash) => {
    h.store!.strings.set(walletKey(payer(1)), String(PURCHASE_QUOTE_WALLET_MAX - 1));
    expect(await quote(1, ipHash)).toBe(true);
    expect(await quote(1, ipHash)).toBe(false);
    expect(h.store!.strings.get(walletKey(payer(1)))).toBe('13');
  });

  it('denies the 61st IP request even when the payer changes', async () => {
    h.store!.strings.set(ipKey(), String(PURCHASE_QUOTE_IP_MAX - 1));
    expect(await quote(60)).toBe(true);
    expect(await quote(61)).toBe(false);
    expect(h.store!.strings.get(ipKey())).toBe('61');
  });

  it('keeps the resource limit across distinct IPs and wallets', async () => {
    h.store!.strings.set(resourceKey, String(PURCHASE_QUOTE_RESOURCE_MAX - 1));
    expect(await quote(120, 'first-ip')).toBe(true);
    expect(await quote(121, 'new-ip')).toBe(false);
    expect(h.store!.strings.get(resourceKey)).toBe(String(PURCHASE_QUOTE_RESOURCE_MAX + 1));
  });

  it.each([null, IP])('starts a fixed window and allows requests again after expiry (ipHash=%s)', async (ipHash) => {
    expect(await quote(1, ipHash)).toBe(true);
    const keys = h.calls[0].keys;
    for (const key of keys) expect(h.store!.getTtl(key)).toBe(PURCHASE_QUOTE_RATE_WINDOW_SEC);
    h.store!.advance(10_000);
    expect(await quote(1, ipHash)).toBe(true);
    for (const key of keys) expect(h.store!.getTtl(key)).toBe(50);
    h.store!.advance(50_000);
    expect(await quote(1, ipHash)).toBe(true);
    for (const key of keys) {
      expect(h.store!.strings.get(key)).toBe('1');
      expect(h.store!.getTtl(key)).toBe(PURCHASE_QUOTE_RATE_WINDOW_SEC);
    }
  });

  it('pins ARGV[2]=0 as both the denied value and the TTL repair threshold', async () => {
    const keys = [walletKey(payer(1)), resourceKey, ipKey()];
    for (const key of keys) h.store!.strings.set(key, '2');
    expect(await quote()).toBe(true);
    const call = h.calls[0];
    expect(call.args[1]).toBe('0');
    for (const key of keys) expect(h.store!.getTtl(key)).toBe(PURCHASE_QUOTE_RATE_WINDOW_SEC);

    // F6 characterization: changing only the denied sentinel to -1 suppresses
    // repair of TTL=-1. Keep this positional coupling visible before refactoring it.
    const changedArgs = [...call.args];
    changedArgs[1] = '-1';
    for (const key of keys) h.store!.persist(key);
    expect(await runRedisLua(call.script, call.keys, changedArgs, h.store!)).toBe(1);
    for (const key of keys) expect(h.store!.getTtl(key)).toBe(-1);
  });

  it.each([
    ['wallet', walletKey(payer(1)), PURCHASE_QUOTE_WALLET_MAX],
    ['resource', resourceKey, PURCHASE_QUOTE_RESOURCE_MAX],
    ['ip', ipKey(), PURCHASE_QUOTE_IP_MAX],
  ] as const)('repairs missing TTL on the denied %s bucket', async (_name, key, max) => {
    h.store!.strings.set(key, String(max));
    expect(await quote()).toBe(false);
    expect(h.store!.strings.get(key)).toBe(String(max + 1));
    expect(h.store!.getTtl(key)).toBe(PURCHASE_QUOTE_RATE_WINDOW_SEC);
  });

  it('validates all key types before any INCR and preserves fail-open behavior', async () => {
    h.store!.sets.set(resourceKey, new Set(['wrong-type']));
    expect(await quote()).toBe(true);
    expect(h.store!.strings.size).toBe(0);
    const call = h.calls[0];
    expect(await runRedisLua(call.script, call.keys, call.args, h.store!)).toBe(-1);
  });

  it('B1: 130 attempts from one IP do not lock out another buyer or consume denied wallets', async () => {
    await quote();
    const call = h.calls[0];
    h.store = createFakeRedisStore();
    const walletIndex = call.keys.indexOf(walletKey(payer(1))) + 1;
    // Execute the actual script 130 times in one engine entry. This batching originally
    // avoided accumulating doString return values on the old harness's shared Lua stack.
    // Per-EVAL factory/engine isolation now fixes that overflow; retain the stress-case batching.
    const results = await runRedisLua(
      'local limit = function() ' + call.script + ' end\n' +
      'local results = {}\n' +
      'for n = 1, 130 do\n' +
      '  KEYS[' + walletIndex + '] = "store:quote:rl:wallet:0x" .. string.format("%040x", n)\n' +
      '  results[n] = limit()\n' +
      'end\nreturn results',
      call.keys, call.args, h.store,
    );
    expect(results).toEqual(Array.from({ length: 130 }, (_, n) => n < PURCHASE_QUOTE_IP_MAX ? 1 : 0));
    expect(h.store!.strings.get(resourceKey)).toBe(String(PURCHASE_QUOTE_IP_MAX));
    expect(h.store!.strings.has(walletKey(payer(61)))).toBe(false);
    expect(await quote(131, 'another-ip')).toBe(true);
  });

  it('B1 review: two IPs sending 60 requests each leave a third buyer allowed', async () => {
    await quote();
    const call = h.calls[0];
    h.store = createFakeRedisStore();
    const walletIndex = call.keys.indexOf(walletKey(payer(1))) + 1;
    const ipIndex = call.keys.indexOf(ipKey()) + 1;
    const results = await runRedisLua(
      'local limit = function() ' + call.script + ' end\n' +
      'local results = {}\n' +
      'for ip = 1, 2 do\n' +
      '  KEYS[' + ipIndex + '] = "store:quote:rl:ip:burst-" .. ip\n' +
      '  for n = 1, 60 do\n' +
      '    local request = (ip - 1) * 60 + n\n' +
      '    KEYS[' + walletIndex + '] = "store:quote:rl:wallet:0x" .. string.format("%040x", request)\n' +
      '    results[request] = limit()\n' +
      '  end\n' +
      'end\nreturn results',
      call.keys, call.args, h.store,
    );
    expect(results).toEqual(Array(120).fill(1));
    expect(h.store.strings.get(ipKey('burst-1'))).toBe('60');
    expect(h.store.strings.get(ipKey('burst-2'))).toBe('60');
    expect(h.store.strings.get(resourceKey)).toBe('120');
    expect(await quote(121, 'third-ip')).toBe(true);
  });
});
