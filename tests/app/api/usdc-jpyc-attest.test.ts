import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, getAddress, TransactionReceiptNotFoundError, zeroAddress, type Hex } from 'viem';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { JPYC_PAYMENT_ATTESTATION_RESPONSE_SCHEMA } from '@/lib/jpyc/liveSchema';

const mocks = vi.hoisted(() => ({ receipt: vi.fn(), block: vi.fn(), latest: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/jpyc/live', async () => ({
  ...await vi.importActual<typeof import('@/lib/jpyc/live')>('@/lib/jpyc/live'),
  clientFor: () => ({ getTransactionReceipt: mocks.receipt, getBlock: mocks.block, getBlockNumber: mocks.latest }),
}));
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validate = ajv.compile(JPYC_PAYMENT_ATTESTATION_RESPONSE_SCHEMA);
const SELLER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const PAYER = SELLER.toLowerCase();
const TX = `0x${'ab'.repeat(32)}` as Hex;
const PATH = '/api/paid/usdc/jpyc/attest';
const FAC = 'https://facilitator.payai.network';
let route: { GET: (request: Request) => Promise<Response> };
let token: Hex;
let event: typeof import('@/lib/jpyc/live').TRANSFER_EVENT;

function request(query = `?chain=polygon&tx=${TX}`, version: 0 | 1 | 2 = 1) {
  const payload = { signature: '0x' + '11'.repeat(65), authorization: {
    from: PAYER, to: SELLER, value: '100000', validAfter: '0', validBefore: '99999999999', nonce: '0x' + '22'.repeat(32),
  } };
  const payment = version === 1 ? { x402Version: 1, scheme: 'exact', network: 'base', payload } : {
    x402Version: 2, resource: { url: 'https://open-pay.jp' + PATH },
    accepted: { scheme: 'exact', network: 'eip155:8453', amount: '100000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: SELLER, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }, payload,
  };
  return new Request('https://open-pay.jp' + PATH + query, { headers: version ? {
    [version === 1 ? 'x-payment' : 'payment-signature']: Buffer.from(JSON.stringify(payment)).toString('base64'),
  } : {} });
}
function log(value: bigint, index: number, address = token) {
  return { address, topics: encodeEventTopics({ abi: [event], eventName: 'Transfer', args: { from: zeroAddress, to: SELLER } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]), logIndex: index,
    blockNumber: 100n, blockHash: TX, transactionHash: TX, transactionIndex: 0, removed: false };
}
function receipt(status = 'success', logs = [log(10n ** 18n, 2), log(5n * 10n ** 17n, 4), log(99n, 5, zeroAddress)]) {
  return { status, logs, blockNumber: 100n, blockHash: TX, transactionHash: TX, from: PAYER, to: token };
}
function onlyVerify() {
  expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual([FAC + '/verify']);
}
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_JPYC_ETHEREUM', 'true');
  vi.stubEnv('NEXT_PUBLIC_ENABLE_JPYC_AVALANCHE', 'true');
  vi.stubEnv('X402_NETWORK', 'base'); vi.stubEnv('X402_PAY_TO_ADDRESS', SELLER);
  vi.stubEnv('X402_FACILITATOR_URL', FAC); vi.stubEnv('X402_TEST_MODE', '');
  vi.stubEnv('X402_RECEIPT_SIGNING_KEY', '0x' + 'c3'.repeat(32));
  vi.stubEnv('KV_REST_API_URL', ''); vi.stubEnv('KV_REST_API_TOKEN', '');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', ''); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  vi.stubGlobal('fetch', mocks.fetch);
  const live = await import('@/lib/jpyc/live');
  token = live.deploymentFor('polygon').address; event = live.TRANSFER_EVENT;
  route = await import('@/app/api/paid/usdc/jpyc/attest/route') as unknown as typeof route;
  mocks.receipt.mockResolvedValue(receipt()); mocks.latest.mockResolvedValue(110n);
  mocks.block.mockImplementation(async ({ blockTag }) => ({ number: blockTag ? 105n : 100n, timestamp: 1_750_000_000n }));
  mocks.fetch.mockImplementation(async (url) => {
    if (String(url).endsWith('/verify')) return Response.json({ isValid: true, payer: PAYER });
    if (String(url).endsWith('/settle')) return Response.json({ success: true, transaction: TX, network: 'base', payer: PAYER });
    throw new Error('Unexpected fetch');
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('JPYC attestation gate and RPC record', () => {
  it.each(['?chain=bad', '?chain=', '?tx=', '?tx=0x12', '?foo=1', '?chain=polygon&chain=polygon', `?tx=${TX}&tx=${TX}`])('400 before payment: %s', async (query) => {
    expect((await route.GET(request(query, 0))).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it.each(['', '?chain=polygon', `?tx=${TX}`])('missing query produces 402, then paid 400: %s', async (query) => {
    const res = await route.GET(request(query, 0));
    expect(res.status).toBe(402);
    expect((await res.json()).accepts[0].maxAmountRequired).toBe('100000');
    const v2 = JSON.parse(Buffer.from(res.headers.get('PAYMENT-REQUIRED')!, 'base64').toString());
    expect(v2.accepts[0]).toMatchObject({ amount: '100000', network: 'eip155:8453' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await route.GET(request(query))).status).toBe(400); onlyVerify();
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
  for (const version of [1, 2] as const) {
    it.each(['missing', 'reverted', 'empty', 'rpc', 'block', 'latest'])(`v${version}: failure %s never settles`, async (kind) => {
      if (kind === 'missing') mocks.receipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: TX }));
      if (kind === 'reverted') mocks.receipt.mockResolvedValue(receipt('reverted'));
      if (kind === 'empty') mocks.receipt.mockResolvedValue(receipt('success', [log(1n, 0, zeroAddress)]));
      if (kind === 'rpc') mocks.receipt.mockRejectedValue(new Error('rpc unavailable'));
      if (kind === 'block') mocks.block.mockRejectedValue(new Error('rpc unavailable'));
      if (kind === 'latest') mocks.latest.mockRejectedValue(new Error('rpc unavailable'));
      const res = await route.GET(request(undefined, version));
      expect(res.status).toBe(['rpc', 'block', 'latest'].includes(kind) ? 503 : 404);
      expect((await res.json()).error).toBe(kind === 'missing' ? 'tx_not_found' : ['reverted', 'empty'].includes(kind) ? 'no_jpyc_transfer' : 'rpc_unavailable');
      onlyVerify();
    });
    it(`v${version}: exact transfers, totals, signature and schema after verify before settle`, async () => {
      const res = await route.GET(request(undefined, version)); const body = await res.json();
      expect(res.status).toBe(200); expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
      expect(body.transfers).toEqual([1n * 10n ** 18n, 5n * 10n ** 17n].map((value, i) => ({ logIndex: i ? 4 : 2, from: zeroAddress, to: SELLER, value: value.toString(), valueJpyc: i ? '0.5' : '1' })));
      expect(body.totals).toEqual({ count: 2, valueJpyc: '1.5' });
      expect(body.confirmations).toBe('11'); expect(body.finality).toEqual({ finalized: true, method: 'finalized-tag', finalizedBlock: '105' });
      expect(body.licensee).toBe(getAddress(PAYER)); expect(body.attestation.message.licensee).toBe(body.licensee);
      const signing = await import('@/lib/jpyc/paymentAttestation');
      expect(body.attestation.message.transfersHash).toBe(signing.transfersHash(body.transfers));
      expect(await signing.verifyJpycPaymentAttestation(body.attestation.message, body.attestation.signature)).toEqual({ valid: true, signer: body.signer });
      expect(body.verify.domain).toEqual(signing.JPYC_PAYMENT_ATTESTATION_EIP712_DOMAIN);
      expect(body.verify.types).toEqual(signing.JPYC_PAYMENT_ATTESTATION_TYPES);
      expect(mocks.fetch.mock.calls.map(([url]) => String(url))).toEqual([FAC + '/verify', FAC + '/settle']);
      expect(mocks.receipt.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.fetch.mock.invocationCallOrder[0]);
      expect(mocks.block.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.fetch.mock.invocationCallOrder[1]);
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  }
  it('no key produces null attestation and signer', async () => {
    vi.stubEnv('X402_RECEIPT_SIGNING_KEY', ''); vi.resetModules();
    route = await import('@/app/api/paid/usdc/jpyc/attest/route') as unknown as typeof route;
    const body = await (await route.GET(request())).json();
    expect(body.attestation).toBeNull(); expect(body.signer).toBeNull(); expect(validate(body)).toBe(true);
  });
  it('unknown payer uses null licensee and signs zero address', async () => {
    mocks.fetch.mockImplementation(async (url) => Response.json(String(url).endsWith('/verify') ? { isValid: true } : { success: true, transaction: TX, network: 'base' }));
    const body = await (await route.GET(request())).json();
    expect(body.licensee).toBeNull(); expect(body.attestation.message.licensee).toBe(zeroAddress);
  });
  it.each(['polygon', 'ethereum', 'kaia', 'avalanche'] as const)('finality for %s', async (slug) => {
    const live = await import('@/lib/jpyc/live');
    token = live.deploymentFor(slug).address; mocks.receipt.mockResolvedValue(receipt());
    mocks.block.mockImplementation(async ({ blockTag }) => {
      if (blockTag) throw new Error('unsupported finalized');
      return { timestamp: 1_750_000_000n };
    });
    const { readJpycPaymentRecord } = await import('@/lib/jpyc/paymentRecord');
    const result = await readJpycPaymentRecord(slug, TX);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.record.finality).toEqual({ finalized: ['kaia', 'avalanche'].includes(slug) ? true : null, method: 'confirmations' });
  });
  it('finalized block behind receipt reports false', async () => {
    mocks.block.mockResolvedValue({ number: 99n, timestamp: 1_750_000_000n });
    const body = await (await route.GET(request())).json();
    expect(body.finality).toEqual({ finalized: false, method: 'finalized-tag', finalizedBlock: '99' });
  });
});
