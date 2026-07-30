import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';

type RelayResult =
  | { kind: 'success'; txHash: Hex }
  | { kind: 'rejected'; httpStatus: number; reason: string };

type RelayAuth = { from: string; to: string };
type SettleInput = {
  params: { from: string };
  rateLimitKeys: string[];
  callerFeeFloorValue: bigint;
};

const CUSTOMER_A = '0x0000000000000000000000000000000000000def';
const CUSTOMER_B = '0x0000000000000000000000000000000000000bed';
const MERCHANT = '0x0000000000000000000000000000000000000abc';
const FORWARDER = '0x0000000000000000000000000000000000000001';
const TX_HASH = `0x${'a'.repeat(64)}` as Hex;
const IP_SECRET = '0123456789abcdef0123456789abcdef';

const hold = vi.hoisted(() => ({
  forwarder: null as string | null,
  forwarderAddress: '0x0000000000000000000000000000000000000001',
  feeReceiver: '0x0000000000000000000000000000000000000fee',
  merchant: '0x0000000000000000000000000000000000000abc',
  customerA: '0x0000000000000000000000000000000000000def',
  sessionAddress: '0x0000000000000000000000000000000000000def',
  limiter: vi.fn<
    (scope: string, hashedIp: string | null, max: number, windowSec: number) => Promise<boolean>
  >(),
  relay: vi.fn<
    (
      chainId: number,
      auth: RelayAuth,
      signature: string,
      rateLimitKeys: string[],
      opts: { idemPrefix: string },
    ) => Promise<RelayResult>
  >(),
  settle: vi.fn<(input: SettleInput) => Promise<RelayResult>>(),
  requireSession: vi.fn(),
  parseFacilitatorRequest: vi.fn(),
  recordRelayedVolume: vi.fn(),
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: (
    scope: string,
    hashedIp: string | null,
    max: number,
    windowSec: number,
  ) => hold.limiter(scope, hashedIp, max, windowSec),
}));

vi.mock('@/lib/relay/relayProvider', () => ({
  PROVIDER: 'self-host',
  MAINNET_CHAINS: new Set<number>(),
  relayMaxGasCostWei: () => 1n,
  SUPPORTED_CHAINS: { 80002: {} },
  relayFreeAuthorization: (
    chainId: number,
    auth: RelayAuth,
    signature: string,
    rateLimitKeys: string[],
    opts: { idemPrefix: string },
  ) => hold.relay(chainId, auth, signature, rateLimitKeys, opts),
  jpycAddressFor: () => null,
}));

vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: () => hold.forwarder,
  configuredJpycForwarderFor: () => hold.forwarderAddress,
  isRecoverRequiredChain: () => false,
  relayGasFeeValue: () => 2n,
}));

vi.mock('@/lib/relay/forwarderSettleService', () => ({
  feeReceiverFor: () => hold.feeReceiver,
  settleViaForwarder: (input: SettleInput) => hold.settle(input),
}));

vi.mock('@/lib/env', () => ({
  env: {
    enableUsageFee: false,
    enableMobileOrderFee: false,
    enablePushNotify: false,
    enableCsvPass: true,
    feeReceiverConfigured: true,
    feeReceiver: hold.feeReceiver,
    enableX402Facilitator: true,
  },
}));

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  // settle 入口の hosted intent gate (purchaseSettleGate) が読む。null = hosted intent 不在 = 素通し。
  kvGet: vi.fn(async () => ({ ok: true, value: null })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/legal', () => ({ feeDisclosureDivergence: () => null }));
vi.mock('@/lib/feeGate', () => ({
  isGaslessRelayBlocked: vi.fn(async () => false),
}));
vi.mock('@/lib/billingMeter', () => ({
  recordRelayedVolume: (...args: unknown[]) => hold.recordRelayedVolume(...args),
}));
vi.mock('@/lib/relay/recoverFee', () => ({ recoverFeeValue: () => 2n }));
vi.mock('@/lib/mobileOrderFee', () => ({
  isMobileOrderFeeKind: () => false,
  mobileOrderFeeValue: () => 2n,
}));
vi.mock('@/lib/push/notify', () => ({ notifyPaymentReceived: vi.fn() }));

vi.mock('../../../app/api/auth/siwe/_session', () => ({
  requireSession: () => {
    hold.requireSession();
    return Promise.resolve({ ok: true, address: hold.sessionAddress });
  },
}));

vi.mock('@/lib/x402/facilitatorConfig', () => ({
  x402FacilitatorConfig: { feeFloorWei: 1n },
  x402FacilitatorReady: () => ({ ready: true }),
}));
vi.mock('@/lib/x402/facilitatorSettle', () => ({
  parseFacilitatorRequest: (raw: { from?: string }) => {
    hold.parseFacilitatorRequest(raw);
    return {
      ok: true,
      parsed: {
        chainId: 80002,
        params: {
          from: raw.from ?? hold.customerA,
          merchant: hold.merchant,
          merchantValue: 1n,
          feeReceiver: hold.feeReceiver,
          feeValue: 2n,
          validAfter: 0n,
          validBefore: 9999999999n,
          intentSalt: `0x${'2'.repeat(64)}`,
        },
        signature: `0x${'b'.repeat(130)}`,
        expectedFeeValue: 2n,
      },
    };
  },
}));
vi.mock('@/lib/x402/network', () => ({ caip2ForChainId: () => 'eip155:80002' }));
vi.mock('@/lib/x402/receipt', () => ({
  makeSettlementReceipt: vi.fn(),
  signReceipt: vi.fn(),
}));
vi.mock('@/lib/x402/registry', () => ({ recordSettlement: vi.fn() }));

import { POST as relayPost } from '@/app/api/relay/jpyc/route';
import { POST as csvPassPost } from '@/app/api/csv-pass/relay/route';
import { POST as facilitatorSettlePost } from '@/app/api/facilitator/settle/route';

function freeBody(from = CUSTOMER_A, nonceByte = '3') {
  return {
    chainId: 80002,
    from,
    to: MERCHANT,
    value: '1',
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce: `0x${nonceByte.repeat(64)}`,
    signature: `0x${'b'.repeat(130)}`,
  };
}

function recoverBody(from = CUSTOMER_A) {
  return {
    chainId: 80002,
    from,
    merchant: MERCHANT,
    merchantValue: '1',
    feeValue: '2',
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    intentSalt: `0x${'2'.repeat(64)}`,
    signature: `0x${'b'.repeat(130)}`,
  };
}

function csvPassBody(from = CUSTOMER_A) {
  return {
    chainId: 80002,
    from,
    value: (100n * 10n ** 18n).toString(),
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce: `0x${'4'.repeat(64)}`,
    signature: `0x${'b'.repeat(130)}`,
  };
}

function request(url: string, body: unknown, ip = '203.0.113.42'): Request {
  return new Request(new URL(url, 'http://localhost'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });
}

function unreadRequest(url: string, body: unknown): { req: Request; text: ReturnType<typeof vi.fn> } {
  const text = vi.fn(async () => JSON.stringify(body));
  const req = {
    headers: new Headers({ 'x-forwarded-for': '203.0.113.42' }),
    text,
  } as unknown as Request;
  return { req, text };
}

beforeEach(() => {
  vi.stubEnv('IP_HASH_SECRET', IP_SECRET);
  hold.forwarder = null;
  hold.sessionAddress = CUSTOMER_A;
  hold.limiter.mockReset();
  hold.limiter.mockResolvedValue(true);
  hold.relay.mockReset();
  hold.relay.mockResolvedValue({
    kind: 'rejected',
    httpStatus: 400,
    reason: 'test_stop',
  });
  hold.settle.mockReset();
  hold.settle.mockResolvedValue({
    kind: 'rejected',
    httpStatus: 400,
    reason: 'test_stop',
  });
  hold.requireSession.mockReset();
  hold.parseFacilitatorRequest.mockReset();
  hold.recordRelayedVolume.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('relay admission IP limiter', () => {
  it('同一 IP は 120 回まで通し、121 回目を verify/RPC・daily budget 前に 429 で止める', async () => {
    const counts = new Map<string, number>();
    hold.limiter.mockImplementation(async (scope, hashedIp, max, windowSec) => {
      expect(scope).toBe('relay-admission');
      expect(hashedIp).not.toBeNull();
      expect(max).toBe(120);
      expect(windowSec).toBe(60);
      const count = (counts.get(hashedIp!) ?? 0) + 1;
      counts.set(hashedIp!, count);
      return count <= max;
    });

    for (let i = 0; i < 120; i++) {
      const res = await relayPost(
        request('/api/relay/jpyc', freeBody(CUSTOMER_A, i.toString(16).slice(-1))),
      );
      expect(res.status).toBe(400);
    }
    const coreCallsBeforeLimit = hold.relay.mock.calls.length;
    const limited = await relayPost(request('/api/relay/jpyc', freeBody()));

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'ip_rate_limited' });
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(hold.relay).toHaveBeenCalledTimes(coreCallsBeforeLimit);
    expect(hold.settle).not.toHaveBeenCalled();
  });

  it.each([
    ['free', freeBody()],
    ['recover', recoverBody()],
  ])('relay %s は limiter 超過時に req.text より前で止まる', async (_mode, body) => {
    hold.limiter.mockResolvedValue(false);
    const { req, text } = unreadRequest('/api/relay/jpyc', body);

    const res = await relayPost(req);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(text).not.toHaveBeenCalled();
    expect(hold.relay).not.toHaveBeenCalled();
    expect(hold.settle).not.toHaveBeenCalled();
  });

  it('csv-pass は limiter 超過時に requireSession / req.text / relay core 前で止まる', async () => {
    hold.limiter.mockResolvedValue(false);
    const { req, text } = unreadRequest('/api/csv-pass/relay', csvPassBody());

    const res = await csvPassPost(req);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'ip_rate_limited' });
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(hold.requireSession).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(hold.relay).not.toHaveBeenCalled();
  });

  it('x402 settle は limiter 超過時に req.text / parse / settle core 前で止まる', async () => {
    hold.limiter.mockResolvedValue(false);
    const { req, text } = unreadRequest('/api/facilitator/settle', { from: CUSTOMER_A });

    const res = await facilitatorSettlePost(req);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'ip_rate_limited' });
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(text).not.toHaveBeenCalled();
    expect(hold.parseFacilitatorRequest).not.toHaveBeenCalled();
    expect(hold.settle).not.toHaveBeenCalled();
  });

  it('IP_HASH_SECRET 未設定なら hashedIp=null で limiter は inert、既存 free フローへ進む', async () => {
    vi.stubEnv('IP_HASH_SECRET', '');
    hold.limiter.mockImplementation(async (_scope, hashedIp) => hashedIp === null);

    const res = await relayPost(request('/api/relay/jpyc', freeBody()));

    expect(res.status).toBe(400);
    expect(hold.limiter).toHaveBeenCalledWith('relay-admission', null, 120, 60);
    expect(hold.relay).toHaveBeenCalledOnce();
  });
});

describe('post-verify wallet limiter keys', () => {
  it('relay free/recover・csv-pass・x402 settle の 4 site は wallet-only', async () => {
    await relayPost(request('/api/relay/jpyc', freeBody()));

    hold.forwarder = FORWARDER;
    await relayPost(request('/api/relay/jpyc', recoverBody()));

    hold.sessionAddress = CUSTOMER_A;
    await csvPassPost(request('/api/csv-pass/relay', csvPassBody()));

    await facilitatorSettlePost(
      request('/api/facilitator/settle', { from: CUSTOMER_A }),
    );

    expect(hold.relay.mock.calls[0][3]).toEqual([getAddress(CUSTOMER_A)]);
    expect(hold.settle.mock.calls[0][0].rateLimitKeys).toEqual([
      getAddress(CUSTOMER_A),
    ]);
    expect(hold.relay.mock.calls[1][3]).toEqual([getAddress(CUSTOMER_A)]);
    expect(hold.settle.mock.calls[1][0].rateLimitKeys).toEqual([CUSTOMER_A]);
    expect(hold.settle.mock.calls[0][0].callerFeeFloorValue).toBe(2n);
    expect(hold.settle.mock.calls[1][0].callerFeeFloorValue).toBe(1n);
  });

  it('同一 /24 の別 wallet は IP 120 上限内なら別 wallet key で通る', async () => {
    hold.relay.mockResolvedValue({ kind: 'success', txHash: TX_HASH });

    const first = await relayPost(
      request('/api/relay/jpyc', freeBody(CUSTOMER_A, '5'), '203.0.113.10'),
    );
    const second = await relayPost(
      request('/api/relay/jpyc', freeBody(CUSTOMER_B, '6'), '203.0.113.200'),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(hold.relay.mock.calls.map((call) => call[3])).toEqual([
      [getAddress(CUSTOMER_A)],
      [getAddress(CUSTOMER_B)],
    ]);
    expect(hold.limiter).toHaveBeenCalledTimes(2);
  });
});
