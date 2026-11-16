// @vitest-environment node
// 公開の読み取り 2 本 (GET /api/discovery/[id]・GET /api/x402/relay/requirements) は、KV で数える IP ごとの
// 制限を通らない。1 回の読みは KV の GET 1 コマンドだけで、何回続けて呼ばれても自分では 429 を返さない。
// relay の verify / settle は今までどおり 'x402-dual-rail' の枠 (60 回 / 60 秒) で数える。
// lib/kv・relayGuards・ipHash・registry は実物。Upstash の REST だけを fetch の層で偽装し、届いたコマンドを数える。
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, enableX402Facilitator: true, enableX402DualRail: true },
  };
});
vi.mock('@/lib/x402/config', () => ({
  x402Config: {
    network: 'base',
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
import { handleDualRailRelay, handleDualRailRequirements } from '@/lib/x402/dualRailRelay';
import { resourceKey } from '@/lib/x402/registry';

const KV_URL = 'https://kv.test';
const SECRET = '0123456789abcdef0123456789abcdef';
const IP = '203.0.113.10';
const ID = 'res-1';
const SELLER = '0x1111111111111111111111111111111111111111';
const SELLER_USDC = '0x2222222222222222222222222222222222222222';
// relayGuards.checkIpRateLimit の鍵 (iprl:v1:<scope>:<IP の HMAC>)。IPv4 は /32 のまま hash する。
const LIMITER_KEY = `iprl:v1:x402-dual-rail:${createHmac('sha256', SECRET).update(`ip:${IP}`).digest('hex')}`;
// 制限の数 + 1。60 回 / 60 秒の枠なら 61 回目が 429 になる回数。
const CALLS = 61;

const kv = {
  values: new Map<string, string>(),
  counters: new Map<string, number>(),
  commands: [] as string[][],
  roundTrips: 0,
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

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith(`${KV_URL}/`)) throw new Error(`unexpected fetch: ${url}`);
  kv.roundTrips += 1;
  const body = JSON.parse(String(init?.body)) as string[] | string[][];
  const json = url === `${KV_URL}/pipeline`
    ? (body as string[][]).map(runCommand)
    : runCommand(body as string[]);
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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
function relay(action: 'verify' | 'settle'): Promise<Response> {
  return handleDualRailRelay(
    new Request(`https://open-pay.jp/api/x402/relay/${action}`, {
      method: 'POST',
      headers: { ...trustedHeaders(), 'content-type': 'application/json' },
      body: '{}',
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

beforeEach(() => {
  kv.values.clear();
  kv.counters.clear();
  kv.commands = [];
  kv.roundTrips = 0;
  kv.values.set(resourceKey(ID), JSON.stringify({
    id: ID,
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
  vi.stubEnv('UPSTASH_REDIS_REST_URL', KV_URL);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token');
  vi.stubEnv('IP_HASH_SECRET', SECRET);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
