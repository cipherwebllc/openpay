// @vitest-environment node
// Stateful route integration: real reservation/redelivery/finalizer Lua, receipt parsing and TTLs.
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics as encodeTopics, getAddress, parseAbi, type Hex } from 'viem';
import { createFakeRedisStore, dispatchRedisCommand, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';
import type { FeeReceiptLog } from '@/lib/feeVerify';

const h = vi.hoisted(() => ({
  db: null as FakeRedisStore | null,
  kvConfigured: true, authorizationUsed: vi.fn(),
  verify: vi.fn(), settle: vi.fn(), status: vi.fn(), statusAllowed: vi.fn(),
  receipt: vi.fn(), push: vi.fn(), metric: vi.fn(), warn: vi.fn(), error: vi.fn(),
  tasks: [] as (() => unknown)[], logs: [] as FeeReceiptLog[],
  shop: null as Record<string, unknown> | null,
  fail: null as ((op: string, keys: string[]) => 'before' | 'after' | undefined) | null,
  beforeEval: null as ((script: string, keys: string[], args: string[]) => void) | null,
  scripts: new Map<string, { keys: string[]; args: string[] }>(),
}));
vi.mock('next/server', async (original) => ({ ...await original<typeof import('next/server')>(), after: (fn: () => unknown) => h.tasks.push(fn) }));
vi.mock('@/lib/handleStore', () => ({ resolveHandle: async () => ({ ok: true, record: h.shop }) }));
vi.mock('@/lib/relay/relayGuards', async (original) => ({ ...await original<typeof import('@/lib/relay/relayGuards')>(), checkRateLimit: async () => true, checkReadRateLimit: async () => true }));
vi.mock('@/app/api/facilitator/verify/route', () => ({ POST: h.verify }));
vi.mock('@/app/api/facilitator/settle/route', () => ({ POST: h.settle }));
vi.mock('@/lib/x402/facilitatorStatus', () => ({ resolveFacilitatorPaymentStatus: h.status }));
vi.mock('@/lib/x402/facilitatorStatusRateLimit', () => ({ checkFacilitatorStatusRateLimit: h.statusAllowed }));
vi.mock('@/lib/push/notify', () => ({ notifyPaymentReceived: h.push }));
vi.mock('@/lib/metrics', () => ({ recordMetric: h.metric }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: h.warn, error: h.error } }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => ({
  getTransactionReceipt: h.receipt,
  readContract: h.authorizationUsed,
  getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
}) }));
vi.mock('@/lib/kv', () => {
  const command = async (op: string, key: string, ...args: unknown[]) => {
    const failure = h.fail?.(op, [key]);
    if (failure === 'before') return { ok: false, reason: 'network_error' };
    const raw = dispatchRedisCommand(h.db!, op, [key, ...args]);
    const value = raw === false ? null : typeof raw === 'object' && 'ok' in raw ? raw.ok : raw;
    return failure === 'after' ? { ok: false, reason: 'network_error' } : { ok: true, value };
  };
  return {
    isKvConfigured: () => h.kvConfigured,
    kvGet: (key: string) => command('GET', key),
    kvSet: (key: string, value: string, opts: { nx?: boolean; ttlSec?: number } = {}) => command('SET', key, value, ...(opts.nx ? ['NX'] : []), ...(opts.ttlSec ? ['EX', opts.ttlSec] : [])),
    kvSetNxGet: (key: string, value: string, ttl: number) => command('SET', key, value, 'EX', ttl, 'NX', 'GET'),
    kvDel: (key: string) => command('DEL', key),
    kvLpush: (key: string, value: string) => command('LPUSH', key, value),
    kvLrange: (key: string, start: number, end: number) => command('LRANGE', key, start, end),
    kvLtrim: (key: string, start: number, end: number) => command('LTRIM', key, start, end),
    kvExpire: (key: string, ttl: number) => command('EXPIRE', key, ttl),
    kvEval: async (script: string, keys: string[], args: string[]) => {
      h.scripts.set(script, { keys, args });
      h.beforeEval?.(script, keys, args);
      const failure = h.fail?.('EVAL', keys);
      if (failure === 'before') return { ok: false, reason: 'network_error' };
      try {
        const value = await runRedisLua(script, keys, args, h.db!);
        return failure === 'after' ? { ok: false, reason: 'network_error' } : { ok: true, value };
      } catch { return { ok: false, reason: 'redis_error' }; }
    },
  };
});

const SELLER = getAddress('0x1234567890123456789012345678901234567890');
const PAYER = getAddress('0xAbCAbCabcAbCAbcAbcAbCABcabcAbCABcaBCaBcA');
const TOKEN = getAddress('0x00000000000000000000000000000000000Ca11a');
const FORWARDER = getAddress('0x752b7aad0089286eb7b553d84d05233d80c9fcb4');
const FEE = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
const OTHER = getAddress('0x1111111111111111111111111111111111111111');
const TX = `0x${'ab'.repeat(32)}` as Hex;
const REPLACEMENT = `0x${'cd'.repeat(32)}` as Hex;
const CHAIN = 80002;
const UNIT = 10n ** 18n;
const NOW = 1_790_200_000_000;
const ABI = parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
let pay: typeof import('@/app/api/agent-order/pay/route');
let notify: typeof import('@/app/api/order/notify/route');
let currentBody: Record<string, unknown>;
let nonce: Hex;
const listKey = 'order:list:' + SELLER.toLowerCase();
const usedKey = 'order:used:' + CHAIN + ':' + TX;
const orders = () => (h.db!.lists.get(listKey) ?? []).map((raw) => JSON.parse(raw));
const reservationKeys = () => h.db!.keys().filter((key) => key.startsWith('order:agentres:'));
const completionKeys = () => h.db!.keys().filter((key) => key.startsWith('order:used:agent:'));
function payload(salt = '22') {
  return { x402Version: 1, scheme: 'exact', network: 'eip155:80002', payload: {
    signature: `0x${'01'.repeat(32)}${'02'.repeat(32)}1b`,
    authorization: { from: PAYER, validAfter: '0', validBefore: String(NOW / 1000 + 600), intentSalt: `0x${salt.repeat(32)}` },
  } };
}
function request(options: { salt?: string; table?: string; pickup?: number; cart?: string; credential?: string } = {}) {
  const cart = Buffer.from(JSON.stringify([{ id: options.cart ?? 'food', qty: 1 }])).toString('base64url');
  const params = new URLSearchParams({ h: 'shop', cart, table: options.table ?? 'A5' });
  if (options.pickup) params.set('pickupAt', String(options.pickup));
  const p = payload(options.salt);
  if (options.credential) p.payload.signature = options.credential;
  return new Request('https://open-pay.jp/api/agent-order/pay?' + params, { headers: { 'X-PAYMENT': Buffer.from(JSON.stringify(p)).toString('base64') } });
}
function publicRequest(extra: Record<string, unknown> = {}) {
  return new Request('https://open-pay.jp/api/order/notify?h=shop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'jpyc', txHash: TX, chainId: CHAIN, merchant: SELLER, items: [{ name: 'attacker', qty: 1, price: '100' }], statusToken: 'p'.repeat(43), ...extra }) });
}
function encodeEventTopics(args: Parameters<typeof encodeTopics>[0]): Hex[] { return encodeTopics(args) as Hex[]; }
function transfer(from = FORWARDER, to = SELLER, value = 100n * UNIT): FeeReceiptLog {
  return { address: TOKEN, topics: encodeEventTopics({ abi: ABI, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
function authorization(n = nonce, emitter = TOKEN): FeeReceiptLog {
  return { address: emitter, topics: encodeEventTopics({ abi: ABI, eventName: 'AuthorizationUsed', args: { authorizer: PAYER, nonce: n } }), data: '0x' };
}
async function prepareReceipt(body: Record<string, unknown>) {
  const { parseFacilitatorRequest } = await import('@/lib/x402/facilitatorSettle');
  const { buildForwarderNonce } = await import('@/lib/relay/forwarderIntent');
  const parsed = parseFacilitatorRequest(body);
  if (!parsed.ok) throw new Error(parsed.reason);
  const p = parsed.parsed.params;
  nonce = buildForwarderNonce(p, CHAIN, FORWARDER);
  h.logs = [transfer(), transfer(FORWARDER, FEE, p.feeValue), authorization(), {
    address: FORWARDER,
    topics: encodeEventTopics({ abi: ABI, eventName: 'Settled', args: { from: p.from, nonce, merchant: p.merchant } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [p.merchantValue, p.feeReceiver, p.feeValue]),
  }];
}
function success(tx = TX) { return { success: true, transaction: tx, network: 'eip155:80002', payer: PAYER }; }
function settledStatus(tx: Hex | null = TX) { return { ok: true, chainId: CHAIN, payer: PAYER, state: 'settled', txHash: tx }; }
async function beginPending() {
  h.settle.mockImplementation(async (req: Request) => { currentBody = await req.json(); await prepareReceipt(currentBody); return Response.json({ success: false, errorReason: 'pending' }, { status: 202 }); });
  expect((await pay.GET(request())).status).toBe(202);
}
async function drain() { for (const task of h.tasks.splice(0)) await task(); }

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  h.kvConfigured = true; h.authorizationUsed.mockResolvedValue(false);
  h.db = createFakeRedisStore(NOW); h.fail = null; h.beforeEval = null; h.tasks = []; h.scripts.clear();
  h.shop = { owner: SELLER, config: { to: SELLER }, storefront: { chain: 'polygon', mode: 'storefront', feePayer: 'merchant', menu: [{ id: 'food', name: 'original', price: '100' }, { id: 'other', name: 'substitute', price: '100' }] } };
  for (const [key, value] of Object.entries({ NEXT_PUBLIC_NETWORK_ENV: 'testnet', NEXT_PUBLIC_ENABLE_X402_FACILITATOR: '1', NEXT_PUBLIC_ENABLE_ORDER_RELAY: '1', ENABLE_AGENT_ORDER: '1', NEXT_PUBLIC_ENABLE_ORDER_PICKUP: '1', NEXT_PUBLIC_ENABLE_PUSH_NOTIFY: '1', NEXT_PUBLIC_ENABLE_MOBILE_ORDER_FEE: '', NEXT_PUBLIC_ENABLE_SHOP_LIVE: '', NEXT_PUBLIC_ENABLE_PREORDER_TIME: '', NEXT_PUBLIC_JPYC_FORWARDER_AMOY: FORWARDER, NEXT_PUBLIC_FEE_RECEIVER_ADDRESS: FEE, NEXT_PUBLIC_JPYC_TESTNET_ADDRESS: TOKEN, X402_FEE_BPS: '100', X402_FEE_FLOOR_JPYC: '2' })) vi.stubEnv(key, value);
  h.verify.mockImplementation(async () => Response.json({ isValid: true, payer: PAYER }));
  h.settle.mockImplementation(async (req: Request) => { currentBody = await req.json(); await prepareReceipt(currentBody); return Response.json(success()); });
  h.status.mockResolvedValue({ ok: true, chainId: CHAIN, payer: PAYER, state: 'indeterminate' });
  h.statusAllowed.mockResolvedValue(true);
  h.receipt.mockImplementation(async () => ({ status: 'success', logs: h.logs, blockNumber: 123n, from: OTHER }));
  pay = await import('@/app/api/agent-order/pay/route'); notify = await import('@/app/api/order/notify/route');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });


export { h, SELLER, PAYER, TOKEN, FORWARDER, FEE, OTHER, TX, REPLACEMENT, CHAIN, UNIT, NOW, ABI, pay, notify, currentBody, nonce, listKey, usedKey, orders, reservationKeys, completionKeys, request, publicRequest, transfer, authorization, prepareReceipt, success, settledStatus, beginPending, drain, encodeEventTopics };
