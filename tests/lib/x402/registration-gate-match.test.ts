// @vitest-environment node
// 新規登録の probe が OpenPay 方式の 402 を返したときの照合 (lib/x402/registrationGateMatch.ts・PR-09b / E-2)。
// 前半: 今動いているゲート (SDK の createJpycGate / createDualGate・登録フォームのスニペット・x402-jpyc-gateway の
// Base + Arc の 402) を本物のカタログの accepts (publicDiscoveryItem) で動かし、その 402 を本物の
// probeGateDetailed に通して、登録の受取先と一致すると判定されることを見る (testnet / mainnet の両方)。
// 後半: 照合の細かい規則 (どの accept・どの項目を見るか)。

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const RESOURCE = 'https://seller.test/api/paid/report';
const ID = 'seller-id';
const SELLER = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'; // checksum (登録の payTo は checksum で保存される)
const USDC_SELLER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = '0x9999999999999999999999999999999999999999';
const FORWARDER = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const FEE_RECEIVER = '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e';
const JPYC_AMOY = '0x00000000000000000000000000000000000Ca11a';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }];
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

type Gate = { handle: (request: Request) => Promise<Response | { paymentResponseHeader: string }> };
type Sdk = {
  createJpycGate: (options: Record<string, unknown>) => Gate;
  createDualGate: (options: Record<string, unknown>) => Gate;
};

async function load(network: 'testnet' | 'mainnet') {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', network);
  vi.stubEnv('NEXT_PUBLIC_FEE_RECEIVER_ADDRESS', FEE_RECEIVER);
  vi.stubEnv('NEXT_PUBLIC_ENABLE_USAGE_FEE', '');
  vi.stubEnv('X402_FEE_BPS', '100');
  vi.stubEnv('X402_FEE_FLOOR_JPYC', '2');
  if (network === 'mainnet') {
    // mainnet は env.ts が以下を必須にする (未設定だと import 時に throw)。
    vi.stubEnv('NEXT_PUBLIC_PIMLICO_API_KEY', 'dummy');
    vi.stubEnv('NEXT_PUBLIC_PIMLICO_SPONSORSHIP_POLICY_ID', 'sp_dummy');
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://dummy@o0.ingest.sentry.io/0');
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_POLYGON', FORWARDER);
  } else {
    vi.stubEnv('NEXT_PUBLIC_JPYC_FORWARDER_AMOY', FORWARDER);
    vi.stubEnv('NEXT_PUBLIC_JPYC_TESTNET_ADDRESS', JPYC_AMOY);
  }
  vi.resetModules();
  const { publicDiscoveryItem } = await import('@/lib/x402/discoveryItem');
  const { probeGateDetailed } = await import('@/lib/x402/moderation');
  const { buildPaywallSnippet } = await import('@/lib/x402/paywallSnippet');
  const match = await import('@/lib/x402/registrationGateMatch');
  const sdk = (await import(pathToFileURL(resolve('packages/x402-sdk/src/index.mjs')).href)) as Sdk;
  // 出品者の掲載 (/api/discovery/[id] が返す形)。accepts はサーバーが設定から作る本物の値。
  const catalogItem = (merchant: string) => publicDiscoveryItem({
    id: ID, merchant, url: RESOURCE, description: 'paid report', priceJpyc: '100', category: 'api',
    payTo: merchant, network: match.registrationAcceptExpectation(merchant).network, active: true, createdAt: 1,
  });
  return { probeGateDetailed, buildPaywallSnippet, match, sdk, catalogItem };
}

// USDC (Base) の面 (/api/x402/relay/requirements の形・SDK の pin 検証を通る値)。
function usdcFace() {
  const v1Accepts = {
    scheme: 'exact', network: 'base', resource: RESOURCE, payTo: USDC_SELLER,
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxAmountRequired: '1000',
  };
  const v2Accept = { ...v1Accepts, network: 'eip155:8453', amount: '1000' };
  return { resourceId: ID, v1Accepts, v2Accept, paymentRequiredHeader: b64({ x402Version: 2, accepts: [v2Accept] }) };
}

type Loaded = Awaited<ReturnType<typeof load>>;
const GATE_KINDS = ['SDK JPYC', 'SDK dual', 'snippet JPYC', 'snippet dual', 'x402-jpyc-gateway Base + Arc'] as const;

// ゲートを動かして、支払いなしのリクエストへの 402 を得る。merchant = ゲートが pin した自分の受取先 (= 掲載の受取先)。
async function gate402(loaded: Loaded, kind: (typeof GATE_KINDS)[number], merchant: string): Promise<Response> {
  const item = loaded.catalogItem(merchant);
  const face = usdcFace();
  const fetchImpl = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.endsWith(`/api/discovery/${ID}`)) return Response.json(item);
    if (url.includes('/api/x402/relay/requirements?')) return Response.json(face);
    throw new Error(`unexpected URL: ${url}`);
  });
  const options = {
    resourceUrl: RESOURCE, resourceId: ID, expectedRecipient: merchant, expectedUsdcRecipient: USDC_SELLER,
    openpayOrigin: 'https://openpay.test', fetchImpl,
  };
  if (kind === 'x402-jpyc-gateway Base + Arc') {
    // ゲートウェイは掲載の accepts の resource だけを差し替え、USDC の v1 accept を並べ、Arc を出すときは
    // PAYMENT-REQUIRED を relay の arc.paymentRequiredHeader (Base + Arc) にする (cipherwebllc/x402-jpyc-gateway lib/gate.ts)。
    const arcV2Accept = { scheme: 'exact', network: 'eip155:5042', amount: '1000', asset: ARC_USDC, payTo: USDC_SELLER };
    return new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [...item.accepts.map((accept) => ({ ...accept, resource: RESOURCE })), face.v1Accepts],
        error: 'payment_required',
      }),
      {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': b64({ x402Version: 2, accepts: [face.v2Accept, arcV2Accept] }),
        },
      },
    );
  }
  let handle: Gate['handle'];
  if (kind.startsWith('SDK')) {
    handle = loaded.sdk[kind === 'SDK dual' ? 'createDualGate' : 'createJpycGate'](options).handle;
  } else {
    const dual = kind === 'snippet dual';
    const code = loaded.buildPaywallSnippet(RESOURCE, {
      resourceId: ID, expectedRecipient: merchant, dualRail: dual, expectedUsdcRecipient: USDC_SELLER,
    });
    handle = new Function('fetch', code.replaceAll('export async function', 'async function') +
      `\nreturn ${dual ? 'x402Gate' : 'jpycGate'};`)(fetchImpl);
  }
  const res = await handle(new Request(RESOURCE));
  if (!(res instanceof Response)) throw new Error('gate did not return a challenge');
  return res;
}

async function probeOf(loaded: Loaded, res: Response) {
  return loaded.probeGateDetailed(RESOURCE, { fetchImpl: (async () => res) as never, lookup: lookupPublic });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.each(['testnet', 'mainnet'] as const)('today\'s seller gates (%s)', (network) => {
  it.each(GATE_KINDS)('%s: 自分の受取先で登録すれば一致する', async (kind) => {
    const loaded = await load(network);
    const res = await gate402(loaded, kind, SELLER);
    expect(res.status).toBe(402);
    const probe = await probeOf(loaded, res);
    expect(probe.result).toBe('openpay');
    expect(probe.accepts.length).toBeGreaterThan(0);
    const expected = loaded.match.registrationAcceptExpectation(SELLER);
    expect(expected.network).toBe(network === 'mainnet' ? 'eip155:137' : 'eip155:80002');
    expect(expected.asset).not.toBeNull();
    expect(expected.forwarder).toBe(FORWARDER);
    expect(loaded.match.gateAcceptMismatch(probe.accepts, expected)).toBeNull();
  });

  it.each(GATE_KINDS)('%s: 他人のゲートの URL を自分の受取先で登録すると payTo の不一致', async (kind) => {
    const loaded = await load(network);
    const probe = await probeOf(loaded, await gate402(loaded, kind, OTHER));
    expect(probe.result).toBe('openpay');
    expect(loaded.match.gateAcceptMismatch(probe.accepts, loaded.match.registrationAcceptExpectation(SELLER)))
      .toBe('payTo');
  });
});

describe('gateAcceptMismatch rules', () => {
  const EXPECTED = { payTo: SELLER, network: 'eip155:137', asset: JPYC_AMOY, forwarder: FORWARDER };
  async function rules() {
    vi.resetModules();
    return import('@/lib/x402/registrationGateMatch');
  }
  function jpyc(overrides: Record<string, unknown> = {}, split: Record<string, unknown> = {}) {
    return {
      scheme: 'exact', network: 'eip155:137', payTo: FORWARDER, asset: JPYC_AMOY,
      extra: { openpay: { mode: 'forwarder-split', forwarder: FORWARDER, merchant: SELLER, ...split } },
      ...overrides,
    };
  }

  it('アドレスは大文字小文字を区別しない', async () => {
    const { gateAcceptMismatch } = await rules();
    expect(gateAcceptMismatch([jpyc({ payTo: FORWARDER.toLowerCase(), asset: JPYC_AMOY.toLowerCase() },
      { merchant: SELLER.toLowerCase(), forwarder: FORWARDER.toUpperCase().replace('0X', '0x') })], EXPECTED)).toBeNull();
  });

  it('forwarder-split でない accept (USDC・Arc・壊れた要素) は見ない', async () => {
    const { gateAcceptMismatch } = await rules();
    expect(gateAcceptMismatch([
      null, 'x', { network: 'base', payTo: OTHER },
      { network: 'eip155:5042', payTo: OTHER, extra: { openpay: { mode: 'other', merchant: OTHER } } },
      jpyc(),
    ], EXPECTED)).toBeNull();
  });

  it('受取先が無い・違う OpenPay accept が 1 つでもあれば payTo', async () => {
    const { gateAcceptMismatch } = await rules();
    expect(gateAcceptMismatch([jpyc({}, { merchant: undefined })], EXPECTED)).toBe('payTo');
    expect(gateAcceptMismatch([jpyc(), jpyc({ network: 'eip155:43114' }, { merchant: OTHER })], EXPECTED)).toBe('payTo');
  });

  it('登録のチェーンの OpenPay accept が無ければ network (別チェーンは受取先だけを見る)', async () => {
    const { gateAcceptMismatch } = await rules();
    expect(gateAcceptMismatch([], EXPECTED)).toBe('network');
    expect(gateAcceptMismatch([jpyc({ network: 'eip155:80002', asset: OTHER, payTo: OTHER })], EXPECTED)).toBe('network');
    expect(gateAcceptMismatch([jpyc({ network: undefined })], EXPECTED)).toBe('network');
    expect(gateAcceptMismatch([jpyc({ network: 'eip155:43114', asset: OTHER, payTo: OTHER }), jpyc()], EXPECTED))
      .toBeNull();
  });

  it('asset・forwarder (extra.openpay.forwarder と wire の payTo) は書かれていれば照合する', async () => {
    const { gateAcceptMismatch } = await rules();
    expect(gateAcceptMismatch([jpyc({ asset: OTHER })], EXPECTED)).toBe('asset');
    expect(gateAcceptMismatch([jpyc({}, { forwarder: OTHER })], EXPECTED)).toBe('forwarder');
    expect(gateAcceptMismatch([jpyc({ payTo: OTHER })], EXPECTED)).toBe('forwarder');
    const { asset: _asset, payTo: _payTo, ...bare } = jpyc();
    void _asset; void _payTo;
    expect(gateAcceptMismatch([{ ...bare, extra: { openpay: { mode: 'forwarder-split', merchant: SELLER } } }], EXPECTED))
      .toBeNull();
  });

  it('設定に JPYC / forwarder が無いチェーンでは asset / forwarder を照合しない', async () => {
    const { gateAcceptMismatch } = await rules();
    expect(gateAcceptMismatch([jpyc({ asset: OTHER, payTo: OTHER }, { forwarder: OTHER })],
      { ...EXPECTED, asset: null, forwarder: null })).toBeNull();
  });
});
