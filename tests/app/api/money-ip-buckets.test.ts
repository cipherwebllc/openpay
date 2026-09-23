import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipLimit: vi.fn(),
  quoteLimit: vi.fn(),
  kvRead: vi.fn(() => {
    throw new Error('Money IP bucket test reached KV before admission rejection');
  }),
}));

vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      enableJpycEip3009: true,
      enableCsvPass: true,
      feeReceiverConfigured: true,
      enableX402Facilitator: true,
      enableX402DualRail: true,
      enableShopsApi: true,
      enableOrderRelay: true,
      enableAgentOrder: true,
      enableOrderCall: true,
      enableRegisterFee: true,
      enableCreatorStore: true,
    },
  };
});
vi.mock('@/lib/relay/relayProvider', () => ({ PROVIDER: 'self-host' }));
vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  // Any pre-admission storage read must fail clearly, without reaching real KV.
  kvGet: mocks.kvRead,
  kvMget: mocks.kvRead,
  kvLrange: mocks.kvRead,
  kvLlen: mocks.kvRead,
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/relay/relayGuards', () => ({ checkIpRateLimit: mocks.ipLimit }));
vi.mock('@/lib/x402/config', () => ({
  x402Config: { vanillaFacilitator: { cdpAuth: { keyId: 'test', keySecret: 'test' } } },
}));
vi.mock('@/lib/x402/purchaseIntent', async (original) => ({
  ...await original<typeof import('@/lib/x402/purchaseIntent')>(),
  checkPurchaseQuoteRateLimit: mocks.quoteLimit,
}));
vi.mock('@/lib/x402/hostedStore', () => ({
  getHostedProduct: vi.fn(async (id: string) => ({
    id,
    owner: '0x1111111111111111111111111111111111111111',
    saleActive: true,
    contentAvailable: true,
    contentRevision: 1,
    usdcEnabled: true,
  })),
  getHostedContent: vi.fn(async () => ({ kind: 'text', value: 'test content' })),
  sellerDisclosureComplete: vi.fn(async () => true),
}));

import { POST as relayPost } from '@/app/api/relay/jpyc/route';
import { POST as relayStatusPost } from '@/app/api/relay/jpyc/status/route';
import { POST as csvPassPost } from '@/app/api/csv-pass/relay/route';
import { POST as settlePost } from '@/app/api/facilitator/settle/route';
import { POST as facilitatorStatusPost } from '@/app/api/facilitator/status/route';
import { POST as orderCallPost } from '@/app/api/order/call/route';
import { POST as registerClaimPost } from '@/app/api/register/claim/route';
import { GET as hostedGet } from '@/app/api/paid/hosted/[id]/route';
import { guardPaidShopsApi } from '@/app/api/shops/_shared';
import { hashIp } from '@/lib/net/ipHash';
import { handleDualRailRelay, handleDualRailRequirements } from '@/lib/x402/dualRailRelay';

const PAYER = '0x1111111111111111111111111111111111111111';
const RESOURCE_ID = `h_${'1'.repeat(32)}`;
const IPV6_A = '2001:db8:1234:5678::1';
const IPV6_B = '2001:db8:1234:5678:abcd:1234:5678:ffff';
const IPV6_OTHER = '2001:db8:1234:5679::1';

function request(ip: string, path = '/api/test', method = 'POST'): Request {
  return new Request(`https://open-pay.jp${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Exercise the production trust path: a Vercel-observed Cloudflare peer.
      'x-vercel-forwarded-for': '173.245.48.1',
      'cf-connecting-ip': ip,
    },
    ...(method === 'POST' ? {
      body: JSON.stringify({
        h: 'testshop', orderId: 'order-1', txHash: `0x${'a'.repeat(64)}`, table: '1',
      }),
    } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('IP_HASH_SECRET', '0123456789abcdef0123456789abcdef');
  // Stop at the admission boundary: no signature verification, RPC or payment IO.
  mocks.ipLimit.mockResolvedValue(false);
  mocks.quoteLimit.mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Also catch readers that swallow the tripwire error and continue to the limiter.
  expect(mocks.kvRead, 'admission rejection must precede KV reads').not.toHaveBeenCalled();
});

const admissionRoutes = [
  { name: 'relay/jpyc', run: relayPost, scope: 'relay-admission', max: 120 },
  { name: 'relay-status', run: relayStatusPost, scope: 'relay-status', max: 30 },
  { name: 'csv-pass/relay', run: csvPassPost, scope: 'relay-admission', max: 120 },
  { name: 'facilitator/settle', run: settlePost, scope: 'relay-admission', max: 120 },
  { name: 'dualRailRelay verify', run: (req: Request) => handleDualRailRelay(req, 'verify'), scope: 'x402-dual-rail', max: 60 },
  { name: 'dualRailRelay settle', run: (req: Request) => handleDualRailRelay(req, 'settle'), scope: 'x402-dual-rail', max: 60 },
  { name: 'dualRailRelay requirements', run: handleDualRailRequirements, scope: 'x402-dual-rail', max: 60 },
  { name: 'shops-paid', run: guardPaidShopsApi, scope: 'shops-paid', max: 10 },
  { name: 'x402-status', run: facilitatorStatusPost, scope: 'x402-status', max: 30 },
  { name: 'order/call', run: orderCallPost, scope: 'order-call', max: 5 },
  { name: 'register/claim', run: registerClaimPost, scope: 'register-claim', max: 60 },
];

describe.each(admissionRoutes)('$name IP bucket', ({ run, scope, max }) => {
  async function bucket(ip: string) {
    const res = await run(request(ip, '/api/test?resourceId=test-resource'));
    expect(res?.status).toBe(429);
    const args = mocks.ipLimit.mock.lastCall!;
    expect(args).toEqual([scope, expect.stringMatching(/^[0-9a-f]{64}$/), max, 60]);
    return args[1] as string;
  }

  it('shares one bucket across two addresses in the same IPv6 /64', async () => {
    expect(await bucket(IPV6_A)).toBe(await bucket(IPV6_B));
  });

  it('keeps different IPv6 /64s in separate buckets', async () => {
    expect(await bucket(IPV6_A)).not.toBe(await bucket(IPV6_OTHER));
  });

  it('preserves IPv4 /32 hashes and separates hosts in the same /24', async () => {
    const first = await bucket('203.0.113.10');
    const second = await bucket('203.0.113.11');
    expect(first).toBe(hashIp('203.0.113.10'));
    expect(second).toBe(hashIp('203.0.113.11'));
    expect(first).not.toBe(second);
  });
});

describe.each(['jpyc', 'usdc'])('hosted %s quote IP bucket', (rail) => {
  async function bucket(ip: string) {
    const res = await hostedGet(
      request(ip, `/api/paid/hosted/${RESOURCE_ID}?payer=${PAYER}&rail=${rail}`, 'GET'),
      { params: Promise.resolve({ id: RESOURCE_ID }) },
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(res.headers.get('Retry-After')).toBe('60');
    const [input] = mocks.quoteLimit.mock.lastCall!;
    expect(input).toEqual({
      payer: PAYER,
      resourceId: RESOURCE_ID,
      ipHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    return input.ipHash as string;
  }

  it('shares one bucket across two addresses in the same IPv6 /64', async () => {
    expect(await bucket(IPV6_A)).toBe(await bucket(IPV6_B));
  });

  it('keeps different IPv6 /64s in separate buckets', async () => {
    expect(await bucket(IPV6_A)).not.toBe(await bucket(IPV6_OTHER));
  });

  it('preserves IPv4 /32 hashes and separates hosts in the same /24', async () => {
    const first = await bucket('203.0.113.10');
    const second = await bucket('203.0.113.11');
    expect(first).toBe(hashIp('203.0.113.10'));
    expect(second).toBe(hashIp('203.0.113.11'));
    expect(first).not.toBe(second);
  });
});
