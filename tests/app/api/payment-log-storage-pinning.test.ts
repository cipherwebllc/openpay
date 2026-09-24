// R6a: literal storage/response contracts, recorded before key consolidation.
// The POST limiter pins run the real checkReadRateLimit (over this file's kv mock) so the
// removal of the route's try/catch is checked against reachable limiter outcomes only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hold = vi.hoisted(() => ({
  tasks: [] as (() => Promise<void>)[],
  limit: vi.fn(),
}));
vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: (task: () => Promise<void>) => { hold.tasks.push(task); },
}));
vi.mock('@/lib/relay/relayGuards', () => ({ checkReadRateLimit: hold.limit }));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: vi.fn(),
  kvLrange: vi.fn(),
  kvLlen: vi.fn(),
  kvIncr: vi.fn(),
  kvExpire: vi.fn(),
  kvSet: vi.fn(),
  kvLpush: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as stats } from '@/app/api/log/payment/stats/route';
import { GET as exportLog } from '@/app/api/log/payment/export/route';
import { POST } from '@/app/api/log/payment/route';
import { isKvConfigured, kvExpire, kvIncr, kvLlen, kvLpush, kvLrange } from '@/lib/kv';
import { PAYMENT_LOG_KV_KEY } from '@/lib/paymentLog';

const TOKEN = 'r6a-admin-test-token';
const PAYMENT = {
  flow: 'direct',
  result: 'success',
  chainId: 137,
  tokenAddress: '0x1111111111111111111111111111111111111111',
  merchant: '0x2222222222222222222222222222222222222222',
  merchantAmount: '100',
};

beforeEach(() => {
  vi.resetAllMocks();
  hold.tasks = [];
  hold.limit.mockResolvedValue(true);
  vi.stubEnv('PAYMENT_LOG_ADMIN_TOKEN', TOKEN);
  vi.mocked(isKvConfigured).mockReturnValue(true);
  vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: [] });
  vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 0 });
  vi.mocked(kvIncr).mockResolvedValue({ ok: true, value: 1 });
  vi.mocked(kvExpire).mockResolvedValue({ ok: true, value: 1 });
  vi.mocked(kvLpush).mockResolvedValue({ ok: true, value: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function postLog() {
  return POST(new Request('https://test.local/api/log/payment', {
    method: 'POST',
    headers: { 'user-agent': 'R6a fixture' },
    body: JSON.stringify(PAYMENT),
  }));
}

async function useRealLimiter() {
  const actual = await vi.importActual<typeof import('@/lib/relay/relayGuards')>('@/lib/relay/relayGuards');
  hold.limit.mockImplementation(actual.checkReadRateLimit);
}

function request(route: string, query = '', auth = `Bearer ${TOKEN}`) {
  return new Request(`https://test.local/api/log/payment/${route}${query}`, {
    headers: { authorization: auth },
  });
}

describe.each([
  { route: 'stats', get: stats, window: 5000, offsetDefaultTo: 4999 },
  { route: 'export', get: exportLog, window: 10000, offsetDefaultTo: 10006 },
])('R6a $route storage boundary', ({ route, get, window, offsetDefaultTo }) => {
  it.each([
    { query: '', from: 0, to: window - 1 },
    { query: '?from=7', from: 7, to: offsetDefaultTo },
    { query: '?from=7&to=9', from: 7, to: 9 },
  ])('pins both read keys and inclusive window $query', async ({ query, from, to }) => {
    const res = await get(request(route, query));
    expect(res.status).toBe(200);
    expect(kvLrange).toHaveBeenCalledTimes(1);
    expect(kvLrange).toHaveBeenCalledWith('openpay:payments:log', from, to);
    expect(kvLlen).toHaveBeenCalledTimes(1);
    expect(kvLlen).toHaveBeenCalledWith('openpay:payments:log');
  });

  it('auth precedes window validation and storage access', async () => {
    const res = await get(request(route, '?from=-1', 'Bearer wrong'));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"ok":false,"error":"unauthorized"}');
    expect(kvLrange).not.toHaveBeenCalled();
    expect(kvLlen).not.toHaveBeenCalled();
  });

  it('rejects one entry beyond the existing window without reading storage', async () => {
    const res = await get(request(route, `?from=0&to=${window}`));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(`{"ok":false,"error":"invalid_window","maxWindow":${window}}`);
    expect(kvLrange).not.toHaveBeenCalled();
    expect(kvLlen).not.toHaveBeenCalled();
  });

  it('preserves the read-failure response bytes', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: false, reason: 'timeout' });
    const res = await get(request(route));
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":false,"error":"kv_read_failed"}');
  });
});

describe('R6a response and writer compatibility', () => {
  it('preserves empty stats JSON bytes, field order and headers', async () => {
    const res = await stats(request('stats'));
    expect(res.status).toBe(200);
    expect([...res.headers]).toEqual([['content-type', 'application/json']]);
    expect(await res.text()).toBe(
      '{"ok":true,"meta":{"dataSource":"client-reported, unverified","verifiedAgainstChain":false,"maxWindow":5000},' +
      '"total":0,"windowFrom":0,"windowTo":4999,"fetched":0,"parseErrors":0,"filteredCount":0,' +
      '"aggregatedCount":0,"invalidEntries":0,"crossChainDeduped":0,"filter":{"chainId":null,"since":null},' +
      '"byChain":[],"byBridge":[],"byProvider":[]}',
    );
  });

  it('preserves export JSON bytes for valid and malformed records with unavailable length', async () => {
    vi.mocked(kvLrange).mockResolvedValue({ ok: true, value: ['{"z":1,"a":"着金"}', 'broken'] });
    vi.mocked(kvLlen).mockResolvedValue({ ok: false, reason: 'timeout' });
    const res = await exportLog(request('export', '?from=7&to=8'));
    expect(res.status).toBe(200);
    expect([...res.headers]).toEqual([['content-type', 'application/json']]);
    expect(await res.text()).toBe(
      '{"ok":true,"total":null,"returned":2,"nextFrom":9,"entries":[{"z":1,"a":"着金"},{"_parseError":true,"raw":"broken"}]}',
    );
  });

  it('pins the public constant, writer bytes, TTL and after-response ordering', async () => {
    expect(PAYMENT_LOG_KV_KEY).toBe('openpay:payments:log');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:34:56.000Z'));
    const res = await postLog();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(hold.limit).toHaveBeenCalledTimes(1);
    expect(hold.limit).toHaveBeenCalledWith('logpay:unknown', 60, 60);
    expect(kvLpush).not.toHaveBeenCalled();
    expect(hold.tasks).toHaveLength(1);
    await hold.tasks[0]();
    expect(kvIncr).toHaveBeenCalledTimes(1);
    expect(kvIncr).toHaveBeenCalledWith('logpay:budget:20260924', { initialTtlSec: 172800 });
    expect(kvLpush).toHaveBeenCalledTimes(1);
    expect(kvLpush).toHaveBeenCalledWith(
      'openpay:payments:log',
      '{"serverTs":"2026-09-24T12:34:56.000Z","userAgent":"R6a fixture","flow":"direct","result":"success","chainId":137,' +
      '"tokenAddress":"0x1111111111111111111111111111111111111111","merchant":"0x2222222222222222222222222222222222222222","merchantAmount":"100"}',
      { trimStart: 0, trimStop: 19999, ttlSec: 3024000 },
    );
  });
});

describe('R6a POST limiter with the real checkReadRateLimit', () => {
  const NOW = new Date('2026-09-24T12:34:56.000Z');
  const LIMIT_KEY = `rl:read:logpay:unknown:${Math.floor(NOW.getTime() / 60_000)}`;

  beforeEach(async () => {
    await useRealLimiter();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it.each([
    { reason: 'network_error' }, { reason: 'timeout' }, { reason: 'http_error' }, { reason: 'parse_error' },
  ] as const)('fails open when limiter storage returns $reason', async ({ reason }) => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: false, reason });
    const res = await postLog();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(kvIncr).toHaveBeenCalledTimes(1);
    expect(kvIncr).toHaveBeenCalledWith(LIMIT_KEY);
    expect(kvExpire).not.toHaveBeenCalled();
    expect(hold.tasks).toHaveLength(1);
  });

  it('skips the limiter storage entirely when KV is unconfigured', async () => {
    vi.mocked(isKvConfigured).mockReturnValue(false);
    const res = await postLog();
    expect(res.status).toBe(200);
    expect(kvIncr).not.toHaveBeenCalled();
    expect(hold.tasks).toHaveLength(1);
  });

  it.each([
    { count: 1, status: 200, expire: true },
    { count: 60, status: 200, expire: false },
  ])('allows count $count (first hit sets the window TTL: $expire)', async ({ count, status, expire }) => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: true, value: count });
    const res = await postLog();
    expect(res.status).toBe(status);
    expect(await res.text()).toBe('{"ok":true}');
    if (expire) {
      expect(kvExpire).toHaveBeenCalledTimes(1);
      expect(kvExpire).toHaveBeenCalledWith(LIMIT_KEY, 120);
    } else {
      expect(kvExpire).not.toHaveBeenCalled();
    }
    expect(hold.tasks).toHaveLength(1);
  });

  it('denies count 61 with the existing 429 bytes and schedules no storage work', async () => {
    vi.mocked(kvIncr).mockResolvedValueOnce({ ok: true, value: 61 });
    const res = await postLog();
    expect(res.status).toBe(429);
    expect([...res.headers]).toEqual([['content-type', 'application/json']]);
    expect(await res.text()).toBe('{"ok":false,"error":"rate_limited"}');
    expect(hold.tasks).toHaveLength(0);
    expect(kvLpush).not.toHaveBeenCalled();
  });
});

describe('C16: stats names are independent of the selected network', () => {
  // Literal expectations: do not derive these from chainNameForId or viem.
  it.each([
    [137, 'Polygon'], [80002, 'Polygon Amoy'],
    [8453, 'Base'], [84532, 'Base Sepolia'],
    [42161, 'Arbitrum One'], [421614, 'Arbitrum Sepolia'],
    [10, 'OP Mainnet'], [11155420, 'OP Sepolia'],
    [8217, 'Kaia'], [1001, 'Kairos Testnet'],
    [1, 'chainId:1'], [11155111, 'chainId:11155111'],
    [43114, 'chainId:43114'], [43113, 'chainId:43113'],
    [5042, 'chainId:5042'], [5042002, 'chainId:5042002'],
    [130, 'chainId:130'], [1301, 'chainId:1301'],
    [480, 'chainId:480'], [4801, 'chainId:4801'],
    [146, 'chainId:146'], [57054, 'chainId:57054'],
    [1329, 'chainId:1329'], [1328, 'chainId:1328'],
    [999, 'chainId:999'], [998, 'chainId:998'],
    [999999, 'chainId:999999'],
  ])('keeps chain %i named %s', async (chainId, chainName) => {
    vi.mocked(kvLrange).mockResolvedValue({
      ok: true, value: [JSON.stringify({ ...PAYMENT, chainId })],
    });
    vi.mocked(kvLlen).mockResolvedValue({ ok: true, value: 1 });
    const res = await stats(request('stats'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byChain).toHaveLength(1);
    expect(body.byChain[0]).toMatchObject({ chainId, chainName });
  });
});
