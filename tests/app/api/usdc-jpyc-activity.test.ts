import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { ACTIVITY_NOW, activityWindow } from '../../helpers/jpycActivity';
import { JPYC_ACTIVITY_PREVIEW_SCHEMA, JPYC_ACTIVITY_RESPONSE_SCHEMA } from '@/lib/jpyc/liveSchema';
import { USDC_JPYC_ACTIVITY } from '@/lib/jpyc/liveResources';

const mocks = vi.hoisted(() => ({ get: vi.fn(), mget: vi.fn(), claim: vi.fn(), release: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/kv', async () => ({
  ...await vi.importActual<typeof import('@/lib/kv')>('@/lib/kv'),
  kvGet: mocks.get, kvMget: mocks.mget, kvSetNxGet: mocks.claim, kvEval: mocks.release,
}));

const ORIGIN = 'https://open-pay.jp';
const PAID = '/api/paid/usdc/jpyc/activity';
const PREVIEW = '/api/jpyc/activity/preview';
const SELLER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const PAYER = '0x9A76ea8Fc0b9f34D34b91d453F2940932C9a7FE0';
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validatePaid = ajv.compile(JPYC_ACTIVITY_RESPONSE_SCHEMA);
const validatePreview = ajv.compile(JPYC_ACTIVITY_PREVIEW_SCHEMA);
type Route = { GET: (request: Request) => Promise<Response> };
let paid: Route;
let preview: Route;

function request(path: string, version?: 1 | 2) {
  if (!version) return new Request(ORIGIN + path);
  const payload = {
    signature: '0x' + '11'.repeat(64) + '1b',
    authorization: { from: PAYER, to: SELLER, value: '10000', validAfter: '0', validBefore: '99999999999', nonce: '0x' + '22'.repeat(32) },
  };
  const payment = version === 1 ? { x402Version: 1, scheme: 'exact', network: 'base', payload } : {
    x402Version: 2,
    resource: { url: ORIGIN + PAID },
    accepted: { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: SELLER, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
    payload,
  };
  return new Request(ORIGIN + path, { headers: {
    [version === 1 ? 'x-payment' : 'payment-signature']: Buffer.from(JSON.stringify(payment)).toString('base64'),
  } });
}

function store(rows = activityWindow()) {
  mocks.get.mockResolvedValue({ ok: true, value: '100' });
  mocks.mget.mockResolvedValue({ ok: true, value: rows.map((b) => JSON.stringify(b)) });
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('X402_NETWORK', 'base');
  vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.stubEnv('X402_FACILITATOR_URL', 'https://facilitator.payai.network');
  vi.stubEnv('X402_TEST_MODE', '');
  vi.stubEnv('KV_REST_API_URL', 'https://kv.test');
  vi.stubEnv('KV_REST_API_TOKEN', 'test');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_WEB3_DIRECTORY', '');
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  paid = await import('@/app/api/paid/usdc/jpyc/activity/route') as unknown as Route;
  preview = await import('@/app/api/jpyc/activity/preview/route');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ACTIVITY_NOW);
  mocks.claim.mockResolvedValue({ ok: true, value: null });
  mocks.release.mockResolvedValue({ ok: true, value: 1 });
  store();
  mocks.fetch.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/verify')) return Response.json({ isValid: true, payer: PAYER });
    if (String(url).endsWith('/settle')) return Response.json({ success: true, transaction: '0x' + 'ab'.repeat(32), network: 'base', payer: PAYER });
    throw new Error('unexpected fetch: ' + url);
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('activity paid: gate 実体で課金境界を検証', () => {
  it.each(['?foo=1', '?chain=polygon&chain=polygon', '?chain=kaia', '?chain=', '?chain=POLYGON',
    '?window=', '?window=1h', '?window=24h&window=24h'])('不正query %s は402より先に400', async (query) => {
    const res = await paid.GET(request(PAID + query));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_query' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each(['', '?chain=polygon', '?chain=polygon&window=24h'])('未署名 %s はKV未設定でもdual-stack402、KV不参照', async (query) => {
    vi.stubEnv('KV_REST_API_URL', '');
    vi.stubEnv('KV_REST_API_TOKEN', '');
    mocks.get.mockResolvedValue({ ok: false, reason: 'unconfigured' });
    const res = await paid.GET(request(PAID + query));
    expect(res.status).toBe(402);
    expect((await res.json()).accepts[0]).toMatchObject({ network: 'base', maxAmountRequired: '10000' });
    const v2 = JSON.parse(Buffer.from(res.headers.get('PAYMENT-REQUIRED')!, 'base64').toString());
    expect(v2.accepts[0]).toMatchObject({ network: 'eip155:8453', amount: '10000' });
    expect(v2.extensions.bazaar.info.input.queryParams).toEqual({ chain: 'polygon', window: '24h' });
    expect(v2.extensions.bazaar.schema.properties.input.properties.queryParams.properties.chain.enum).toEqual(['polygon']);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.mget).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  for (const version of [1, 2] as const) {
    it('v' + version + ': 支払い付きchain欠落は400・KV本体不参照・settleなし', async () => {
      const res = await paid.GET(request(PAID, version));
      expect(res.status).toBe(400);
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.mget).not.toHaveBeenCalled();
      expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://facilitator.payai.network/verify']);
      expect(mocks.release).toHaveBeenCalledOnce();
    });

    it.each(['missing', 'malformed', 'schema', 'overflow', 'stale', 'future', 'unconfigured', 'storage', 'exception'])('v' + version + ': %s は503・settle不呼出', async (kind) => {
      const rows = activityWindow(kind === 'stale' ? ACTIVITY_NOW - 14_400_001 : kind === 'future' ? ACTIVITY_NOW + 60_001 : ACTIVITY_NOW);
      if (kind === 'overflow') Object.assign(rows[1], { items: [], overflow: true, eventCount: 5_001 });
      if (kind === 'schema') Object.assign(rows[1], { schema: 2 });
      const values: (string | null)[] = rows.map((b) => JSON.stringify(b));
      if (kind === 'missing') values[12] = null;
      if (kind === 'malformed') values[1] = '{';
      mocks.mget.mockResolvedValue({ ok: true, value: values });
      if (kind === 'unconfigured' || kind === 'storage') mocks.get.mockResolvedValue({ ok: false, reason: kind === 'storage' ? 'timeout' : 'unconfigured' });
      if (kind === 'exception') mocks.get.mockRejectedValue(new Error('storage threw'));
      const res = await paid.GET(request(PAID + '?chain=polygon', version));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: kind === 'missing' ? 'data_incomplete' : kind === 'stale' ? 'data_stale' : 'data_unavailable' });
      expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://facilitator.payai.network/verify']);
      expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('v' + version + ': 完全窓はajv適合200・verify後に読みsettle・no-store', async () => {
      const res = await paid.GET(request(PAID + '?chain=polygon&window=24h', version));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(validatePaid(body), JSON.stringify(validatePaid.errors)).toBe(true);
      expect(body.observedAt).toBe(body.toTimestamp);
      expect(Date.parse(body.expiresAt) - Date.parse(body.observedAt)).toBe(14_400_000);
      expect(body.transferCount).toBe(24);
      expect(body).not.toHaveProperty('coverage');
      expect(body).not.toHaveProperty('items');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://facilitator.payai.network/verify', 'https://facilitator.payai.network/settle']);
      expect(mocks.get.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.fetch.mock.invocationCallOrder[0]);
      expect(mocks.mget.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[1]);
    });
  }

  it('4hちょうどの完全な0件窓も200 (欠落から0件を作らない)', async () => {
    const rows = activityWindow(ACTIVITY_NOW - 14_400_000).map((b) => ({ ...b, items: [], eventCount: 0 }));
    store(rows);
    const res = await paid.GET(request(PAID + '?chain=polygon', 1));
    expect(res.status).toBe(200);
    expect((await res.json()).transferCount).toBe(0);
  });
});

describe('activity preview: flagなし・同じ封筒・有効期限内のキャッシュ', () => {
  it('availableは実際の件数だけをsampleにし、価格はSoT、ajv適合', async () => {
    const res = await preview.GET(request(PREVIEW));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validatePreview(body), JSON.stringify(validatePreview.errors)).toBe(true);
    expect(body.available).toBe(true);
    expect(body.sample).toEqual({ transferCount: 24 });
    expect(body.fullFeed.priceUsd).toBe(USDC_JPYC_ACTIVITY.priceUsd);
    expect(body.fullFeed.usdc).toBe(ORIGIN + PAID + '?chain=polygon&window=24h');
    expect(body.fullFeed.hint).toBe('Check before you buy: if observedAt equals the observedAt of your last paid response, the paid aggregate is unchanged -- skip the purchase. Buy only when observedAt has advanced and expiresAt has not passed.');
    expect(body).not.toHaveProperty('topReceivers');
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=300, stale-while-revalidate=600');
  });

  it.each(['data_incomplete', 'data_unavailable', 'data_stale'])('unavailable %s は同じ商品封筒・sampleなし', async (reason) => {
    if (reason === 'data_incomplete') mocks.mget.mockResolvedValue({ ok: true, value: Array(25).fill(null) });
    if (reason === 'data_unavailable') mocks.get.mockResolvedValue({ ok: false, reason: 'unconfigured' });
    if (reason === 'data_stale') store(activityWindow(ACTIVITY_NOW - 14_400_001));
    const res = await preview.GET(request(PREVIEW + '?chain=polygon'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(validatePreview(body), JSON.stringify(validatePreview.errors)).toBe(true);
    expect(body).toMatchObject({ teaser: true, product: 'jpyc-network-activity', chain: 'polygon', window: '24h', available: false, reason });
    expect(body).not.toHaveProperty('sample');
    expect(body.fullFeed.priceUsd).toBe(USDC_JPYC_ACTIVITY.priceUsd);
    expect(body.paidFields).toContain('topReceivers');
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60');
  });

  it.each([[450_000, 300, 150], [120_500, 120, 0], [0, 0, 0]])('残り%s msではfresh+SWR合計を上限内に収める', async (remaining, fresh, stale) => {
    store(activityWindow(ACTIVITY_NOW - 14_400_000 + remaining));
    const res = await preview.GET(request(PREVIEW));
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=' + fresh + ', stale-while-revalidate=' + stale);
  });

  it.each(['?chain=', '?chain=kaia', '?foo=1', '?window=24h', '?chain=polygon&chain=polygon'])('不正query %s は400・KV不参照', async (query) => {
    expect((await preview.GET(request(PREVIEW + query))).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
