// @vitest-environment node
// 公開の読み取り 2 本 (GET /api/discovery/[id]・GET /api/x402/relay/requirements) は、KV で数える IP ごとの
// 制限を通らない。1 回の読みは KV の GET 1 コマンドだけで、何回続けて呼ばれても自分では 429 を返さない。
// relay の verify / settle は今までどおり 'x402-dual-rail' の枠 (60 回 / 60 秒) で数える。
// 制限が無い代わりに、2 本の失敗の警告 (Sentry の event) は instance ごとに 60 秒に 1 回まで (lib/warnThrottle.ts)。
// verify / settle から呼ばれた accepts の失敗の警告は抑えない (失敗のたびに出る)。
// lib/kv・relayGuards・ipHash・registry・warnThrottle は実物。Upstash の REST だけを fetch の層で偽装し、届いたコマンドを数える。
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ network: 'base' }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, enableX402Facilitator: true, enableX402DualRail: true },
  };
});
vi.mock('@/lib/x402/config', () => ({
  x402Config: {
    // USDC の要件を作れない設定不正 (base 系でない network) を test ごとに差し替える。
    get network() {
      return cfg.network;
    },
    payTo: '0x00000000000000000000000000000000000000FE',
    testMode: false,
    vanillaFacilitator: { url: 'https://cdp.example', cdpAuth: { keyId: 'k', keySecret: 's' } },
    arcGateway: { enabled: false },
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET as discoveryGet } from '@/app/api/discovery/[id]/route';
import { logger } from '@/lib/logger';
import { __resetWarnThrottleForTest } from '@/lib/warnThrottle';
import { handleDualRailRelay, handleDualRailRequirements } from '@/lib/x402/dualRailRelay';
import { resourceKey } from '@/lib/x402/registry';

const KV_URL = 'https://kv.test';
// lib/kv が叩く宛先はこの 2 つだけ。ほかの宛先への fetch は想定外 (afterEach で 0 を確かめる)。
const KV_ENDPOINTS = new Set([`${KV_URL}/`, `${KV_URL}/pipeline`]);
const SECRET = '0123456789abcdef0123456789abcdef';
const IP = '203.0.113.10';
const ID = 'res-1';
const SELLER = '0x1111111111111111111111111111111111111111';
const SELLER_USDC = '0x2222222222222222222222222222222222222222';
// relayGuards.checkIpRateLimit の鍵 (iprl:v1:<scope>:<IP の HMAC>)。IPv4 は /32 のまま hash する。
const LIMITER_KEY = `iprl:v1:x402-dual-rail:${createHmac('sha256', SECRET).update(`ip:${IP}`).digest('hex')}`;
// 制限の数 + 1。60 回 / 60 秒の枠なら 61 回目が 429 になる回数。
const CALLS = 61;
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
// 掲載の GET だけが失敗する (INCR などは通る) ときに Upstash が返す形 (非 2xx + {error})。
const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';

const kv = {
  values: new Map<string, string>(),
  counters: new Map<string, number>(),
  commands: [] as string[][],
  roundTrips: 0,
  // 全部の fetch の宛先 (想定外の宛先も含む)。想定外の fetch は throw され、呼ぶ側に握りつぶされうるので、
  // commands の完全一致とは別に、ここで回数と宛先を確かめる。
  fetches: [] as string[],
  failGets: false,
};

function runCommand(command: string[]): { result: unknown } {
  kv.commands.push(command);
  const [name, key] = command;
  if (name === 'GET') return { result: kv.values.get(key) ?? null };
  if (name === 'INCR') {
    const next = (kv.counters.get(key) ?? 0) + 1;
    kv.counters.set(key, next);
    return { result: next };
  }
  // EXPIRE と、想定していないコマンド。どちらも commands に残り、期待との完全一致の比較に出る。
  return { result: 1 };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  kv.fetches.push(url);
  if (!KV_ENDPOINTS.has(url)) throw new Error(`unexpected fetch: ${url}`);
  kv.roundTrips += 1;
  const body = JSON.parse(String(init?.body)) as string[] | string[][];
  if (url === `${KV_URL}/pipeline`) return jsonResponse((body as string[][]).map(runCommand));
  const command = body as string[];
  if (kv.failGets && command[0] === 'GET') {
    kv.commands.push(command);
    return jsonResponse({ error: WRONGTYPE }, 400);
  }
  return jsonResponse(runCommand(command));
});

// 本番と同じ信頼の経路: Vercel が見た接続元が Cloudflare で、本当の IP は cf-connecting-ip。
function trustedHeaders(): Record<string, string> {
  return { 'x-vercel-forwarded-for': '173.245.48.1', 'cf-connecting-ip': IP };
}

function readDiscovery(id: string): Promise<Response> {
  return discoveryGet(
    new Request(`https://open-pay.jp/api/discovery/${id}`, { headers: trustedHeaders() }),
    { params: Promise.resolve({ id }) },
  );
}

function readRequirements(id: string): Promise<Response> {
  return handleDualRailRequirements(
    new Request(`https://open-pay.jp/api/x402/relay/requirements?resourceId=${id}`, {
      headers: trustedHeaders(),
    }),
  );
}

// resourceId の無い body: 制限を通った後、KV も facilitator も読まずに 400 で終わる。
// resourceId を渡すと、制限の後に掲載を読み、USDC の要件を作るところまで進む。
function relay(action: 'verify' | 'settle', resourceId?: string): Promise<Response> {
  return handleDualRailRelay(
    new Request(`https://open-pay.jp/api/x402/relay/${action}`, {
      method: 'POST',
      headers: { ...trustedHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(resourceId === undefined ? {} : { resourceId }),
    }),
    action,
  );
}

function limiterCommands(count: number): string[][] {
  return Array.from({ length: count }, () => [
    ['INCR', LIMITER_KEY],
    ['EXPIRE', LIMITER_KEY, '60', 'NX'],
  ]).flat();
}

function seedListing(id: string): void {
  kv.values.set(resourceKey(id), JSON.stringify({
    id,
    merchant: SELLER,
    url: 'https://seller.example/api/data',
    description: 'Seller paid data API',
    priceJpyc: '10',
    category: 'api',
    payTo: SELLER,
    network: 'eip155:137',
    active: true,
    createdAt: 1,
    usdc: { payTo: SELLER_USDC, priceUsd: '0.005', serviceName: 'Seller Data' },
  }));
}

// その名前の警告が logger.warn に渡った回 (fields)。
function warned(event: string): unknown[] {
  return vi.mocked(logger.warn).mock.calls.filter(([msg]) => msg === event).map(([, fields]) => fields);
}

function at(ms: number): void {
  vi.setSystemTime(T0 + ms);
}

beforeEach(() => {
  kv.values.clear();
  kv.counters.clear();
  kv.commands = [];
  kv.roundTrips = 0;
  kv.fetches = [];
  kv.failGets = false;
  cfg.network = 'base';
  seedListing(ID);
  vi.mocked(logger.warn).mockClear();
  __resetWarnThrottleForTest();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', KV_URL);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token');
  vi.stubEnv('IP_HASH_SECRET', SECRET);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  try {
    // 想定外の宛先への fetch は 0。KV への fetch は数えた往復の数と同じ (どれも KV_ENDPOINTS の宛先)。
    expect(kv.fetches.filter((url) => !KV_ENDPOINTS.has(url))).toEqual([]);
    expect(kv.fetches).toHaveLength(kv.roundTrips);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

const reads = [
  {
    name: 'GET /api/discovery/[id]',
    read: readDiscovery,
    okCache: 'public, s-maxage=300',
    missing: { error: 'not_found' },
  },
  {
    name: 'GET /api/x402/relay/requirements',
    read: readRequirements,
    okCache: 'no-store',
    missing: { error: 'resource_not_found' },
  },
];

describe.each(reads)('$name は KV の IP 制限を数えない', ({ read, okCache, missing }) => {
  it('同じ IP から 61 回続けて呼んでも 429 にならず、KV は request ごとに GET 1 だけ', async () => {
    for (let i = 0; i < CALLS; i += 1) {
      const res = await read(ID);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(okCache);
    }
    expect(kv.commands).toEqual(Array.from({ length: CALLS }, () => ['GET', resourceKey(ID)]));
    expect(kv.roundTrips).toBe(CALLS);
    expect(kv.fetches).toEqual(Array.from({ length: CALLS }, () => `${KV_URL}/`));
    expect(kv.counters.size).toBe(0);
  });

  it('掲載の無い ID を 61 回続けて呼んでも 404 のままで、KV は request ごとに GET 1 だけ', async () => {
    for (let i = 0; i < CALLS; i += 1) {
      const res = await read('missing');
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual(missing);
    }
    expect(kv.commands).toEqual(Array.from({ length: CALLS }, () => ['GET', resourceKey('missing')]));
    expect(kv.roundTrips).toBe(CALLS);
  });

  it('長さの合わない ID は KV を使わずに 400', async () => {
    for (let i = 0; i < CALLS; i += 1) {
      const res = await read('a'.repeat(101));
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'invalid_resource_id' });
    }
    expect(kv.commands).toEqual([]);
    expect(kv.roundTrips).toBe(0);
    expect(kv.fetches).toEqual([]);
  });
});

describe.each(['verify', 'settle'] as const)('POST /api/x402/relay/%s は今までどおり KV の IP 制限を数える', (action) => {
  it('60 回まで通り、61 回目が 429。判定は毎回 INCR + EXPIRE NX の 2 コマンド', async () => {
    for (let i = 0; i < CALLS - 1; i += 1) {
      const res = await relay(action);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_resource_id' });
    }
    const limited = await relay(action);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(kv.commands).toEqual(limiterCommands(CALLS));
    expect(kv.roundTrips).toBe(CALLS);
  });
});

describe('requirements は verify / settle の枠を使わない', () => {
  it('requirements を 61 回呼んだ後でも、同じ IP の verify / settle は 60 回通る', async () => {
    for (let i = 0; i < CALLS; i += 1) {
      expect((await readRequirements(ID)).status).toBe(200);
    }
    expect(kv.counters.size).toBe(0);
    // verify と settle は 1 つの枠を分け合う (30 回ずつで 60 回)。
    for (let i = 0; i < 30; i += 1) {
      expect((await relay('verify')).status).toBe(400);
      expect((await relay('settle')).status).toBe(400);
    }
    expect((await relay('verify')).status).toBe(429);
    expect((await relay('settle')).status).toBe(429);
    expect(kv.counters.get(LIMITER_KEY)).toBe(62);
  });

  it('verify / settle の枠を使い切った IP でも、公開の読み取り 2 本は読める', async () => {
    for (let i = 0; i < CALLS - 1; i += 1) {
      expect((await relay('settle')).status).toBe(400);
    }
    expect((await relay('settle')).status).toBe(429);
    kv.commands = [];
    expect((await readRequirements(ID)).status).toBe(200);
    expect((await readDiscovery(ID)).status).toBe(200);
    expect(kv.commands).toEqual([['GET', resourceKey(ID)], ['GET', resourceKey(ID)]]);
    // 読み取りの後も、verify / settle は制限されたまま。
    expect((await relay('verify')).status).toBe(429);
  });
});

describe('GET /api/discovery/[id] の掲載の読み取りの失敗の警告は 60 秒に 1 回まで', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    kv.failGets = true;
  });

  async function expect503(id: string): Promise<void> {
    const res = await readDiscovery(id);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
  }

  it('同じ ID で 61 回失敗しても警告は最初の 1 回だけ・応答は毎回 503 (no-store)・60 秒たつとまた 1 回', async () => {
    for (let i = 0; i < CALLS; i += 1) await expect503(ID);
    expect(warned('x402.discovery.read_failed')).toEqual([{ id: ID }]);
    expect(kv.commands).toEqual(Array.from({ length: CALLS }, () => ['GET', resourceKey(ID)]));
    at(59_999);
    await expect503(ID);
    expect(warned('x402.discovery.read_failed')).toHaveLength(1);
    at(60_000);
    await expect503(ID);
    expect(warned('x402.discovery.read_failed')).toEqual([{ id: ID }, { id: ID }]);
  });

  it('ID が毎回違っても、警告は 60 秒に 1 回 (request の値で別に数えない)', async () => {
    for (let i = 0; i < CALLS; i += 1) await expect503(`res-${i}`);
    expect(warned('x402.discovery.read_failed')).toEqual([{ id: 'res-0' }]);
  });
});

describe('accepts を作れない設定不正の警告 (x402.dualrail.accepts_failed)', () => {
  const failed = { resourceId: ID, error: 'vanilla x402: unsupported network for USDC gate: polygon-amoy' };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
    cfg.network = 'polygon-amoy';
  });

  async function expectUnconfigured(res: Response): Promise<void> {
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'relay_unconfigured' });
  }

  it('requirements から 61 回失敗しても警告は最初の 1 回だけ・応答は毎回 503・60 秒たつとまた 1 回', async () => {
    for (let i = 0; i < CALLS; i += 1) await expectUnconfigured(await readRequirements(ID));
    expect(warned('x402.dualrail.accepts_failed')).toEqual([failed]);
    at(59_999);
    await expectUnconfigured(await readRequirements(ID));
    expect(warned('x402.dualrail.accepts_failed')).toHaveLength(1);
    at(60_000);
    await expectUnconfigured(await readRequirements(ID));
    expect(warned('x402.dualrail.accepts_failed')).toEqual([failed, failed]);
  });

  it('requirements の掲載が毎回違っても、警告は 60 秒に 1 回 (request の値で別に数えない)', async () => {
    for (let i = 0; i < CALLS; i += 1) seedListing(`res-${i}`);
    for (let i = 0; i < CALLS; i += 1) await expectUnconfigured(await readRequirements(`res-${i}`));
    expect(warned('x402.dualrail.accepts_failed')).toEqual([{ ...failed, resourceId: 'res-0' }]);
  });

  it('verify / settle から呼ばれた失敗は毎回警告する (main と同じ)・requirements の抑えと別に数える', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expectUnconfigured(await relay('verify', ID));
      await expectUnconfigured(await relay('settle', ID));
    }
    expect(warned('x402.dualrail.accepts_failed')).toEqual(Array.from({ length: 6 }, () => failed));
    // verify / settle の警告で、requirements の最初の 1 回は消えない。
    await expectUnconfigured(await readRequirements(ID));
    expect(warned('x402.dualrail.accepts_failed')).toHaveLength(7);
    // requirements の抑えは verify / settle に及ばない。
    for (let i = 0; i < 3; i += 1) {
      await expectUnconfigured(await readRequirements(ID));
      await expectUnconfigured(await relay('verify', ID));
      await expectUnconfigured(await relay('settle', ID));
    }
    expect(warned('x402.dualrail.accepts_failed')).toHaveLength(13);
    // verify / settle は今までどおり制限を数えてから掲載を読む (INCR + EXPIRE NX + GET)。
    expect(kv.counters.get(LIMITER_KEY)).toBe(12);
  });
});
