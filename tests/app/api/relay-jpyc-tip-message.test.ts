import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';

const JPYC = 10n ** 18n;
const TX_HASH = `0x${'a'.repeat(64)}` as Hex;
const CUSTOMER = '0x0000000000000000000000000000000000000def';
const MERCHANT = '0x0000000000000000000000000000000000000abc';
const DECOY = '0x0000000000000000000000000000000000000bad';
const FEE_RECEIVER = '0x0000000000000000000000000000000000000fee';
const FORWARDER = '0x0000000000000000000000000000000000000001';

const hold = vi.hoisted(() => ({
  enableTipMessage: true,
  forwarder: null as string | null,
  relay: vi.fn(),
  settle: vi.fn(),
  record: vi.fn(),
  store: vi.fn(),
  sanitize: vi.fn(),
  after: vi.fn(),
  afterTasks: [] as Promise<unknown>[],
  idem: { state: 'missing' } as
    | { state: 'missing' }
    | { state: 'hash'; txHash: Hex }
    | { state: 'indeterminate' },
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: ResponseInit = {}) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
  },
  after: (callback: () => unknown) => {
    hold.after(callback);
    try {
      hold.afterTasks.push(Promise.resolve(callback()));
    } catch (error) {
      hold.afterTasks.push(Promise.reject(error));
    }
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    enableUsageFee: false,
    enableMobileOrderFee: false,
    enablePushNotify: false,
    enableJpycEip3009: true,
    get enableTipMessage() {
      return hold.enableTipMessage;
    },
  },
}));

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  kvDel: vi.fn(),
  kvEval: vi.fn(),
  kvLrange: vi.fn(),
  // settle 入口の hosted intent gate (purchaseSettleGate) が読む。null = hosted intent 不在 = 素通し。
  kvGet: vi.fn(async () => ({ ok: true, value: null })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/legal', () => ({
  feeDisclosureDivergence: () => null,
}));

vi.mock('@/lib/billingMeter', () => ({
  recordRelayedVolume: (...args: unknown[]) => hold.record(...args),
}));

vi.mock('@/lib/feeGate', () => ({
  isGaslessRelayBlocked: vi.fn(async () => false),
}));

vi.mock('@/lib/net/ipHash', () => ({
  clientIp: () => '203.0.113.10',
  hashIp: () => 'hashed-ip',
}));

vi.mock('@/lib/relay/relayGuards', () => ({
  checkIpRateLimit: vi.fn(async () => true),
  readIdempotency: vi.fn(async () => hold.idem),
}));

vi.mock('@/lib/relay/relayProvider', () => ({
  PROVIDER: 'self-host',
  MAINNET_CHAINS: new Set<number>(),
  relayMaxGasCostWei: () => 1n,
  SUPPORTED_CHAINS: { 80002: {} },
  relayFreeAuthorization: (...args: unknown[]) => hold.relay(...args),
  jpycAddressFor: () =>
    '0x0000000000000000000000000000000000000002',
  readAuthorizationUsed: vi.fn(async () => false),
  findAuthorizationUsedTransactionHash: vi.fn(async () => null),
}));

vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: () => hold.forwarder,
  configuredJpycForwarderFor: () => hold.forwarder,
  isRecoverRequiredChain: () => false,
  relayGasFeeValue: () => 2n * 10n ** 18n,
}));

vi.mock('@/lib/relay/forwarderSettleService', () => ({
  feeReceiverFor: () =>
    '0x0000000000000000000000000000000000000fee',
  settleViaForwarder: (...args: unknown[]) => hold.settle(...args),
}));

vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: () => 2n * 10n ** 18n,
}));

vi.mock('@/lib/mobileOrderFee', () => ({
  isMobileOrderFeeKind: () => false,
  mobileOrderFeeValue: () => 2n * 10n ** 18n,
}));

vi.mock('@/lib/push/notify', () => ({
  notifyPaymentReceived: vi.fn(),
}));

// 月次メトリクスは after を経由するため mock で無効化 — 本 suite の after 計数フェンスは
// tipMessage 保存の after だけを対象にする (メトリクス自体は tests/lib/metrics.test.ts が検証)。
vi.mock('@/lib/metrics', () => ({
  recordMetricAfterResponse: vi.fn(),
}));

vi.mock('@/lib/tipMessages', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/tipMessages')>();
  return {
    ...actual,
    sanitizeTipMessage: (raw: unknown) => {
      hold.sanitize(raw);
      return actual.sanitizeTipMessage(raw);
    },
    storeTipMessage: (...args: unknown[]) => hold.store(...args),
  };
});

import { logger } from '@/lib/logger';
import { POST as relayPost } from '@/app/api/relay/jpyc/route';
import { POST as statusPost } from '@/app/api/relay/jpyc/status/route';

function req(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify(body),
  });
}

function freeBody(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 80002,
    from: CUSTOMER,
    to: MERCHANT,
    value: JPYC.toString(),
    validAfter: '0',
    validBefore: '9999999999',
    nonce: `0x${'3'.repeat(64)}`,
    signature: `0x${'b'.repeat(130)}`,
    ...overrides,
  };
}

function recoverBody(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 80002,
    from: CUSTOMER,
    merchant: MERCHANT,
    merchantValue: (5n * JPYC).toString(),
    feeValue: (2n * JPYC).toString(),
    gasMode: 'customer',
    validAfter: '0',
    validBefore: '9999999999',
    intentSalt: `0x${'2'.repeat(64)}`,
    signature: `0x${'b'.repeat(130)}`,
    ...overrides,
  };
}

function serializedLoggerCalls(): string {
  return JSON.stringify({
    debug: vi.mocked(logger.debug).mock.calls,
    info: vi.mocked(logger.info).mock.calls,
    warn: vi.mocked(logger.warn).mock.calls,
    error: vi.mocked(logger.error).mock.calls,
  });
}

async function settleAfterTasks() {
  return Promise.allSettled(hold.afterTasks);
}

beforeEach(() => {
  vi.clearAllMocks();
  hold.enableTipMessage = true;
  hold.forwarder = null;
  hold.afterTasks = [];
  hold.idem = { state: 'missing' };
  hold.relay.mockResolvedValue({ kind: 'success', txHash: TX_HASH });
  hold.settle.mockResolvedValue({ kind: 'success', txHash: TX_HASH });
  hold.record.mockResolvedValue(undefined);
  hold.store.mockResolvedValue(true);
});

describe('POST /api/relay/jpyc — private tipMessage attachment', () => {
  it('free success は auth の権威値と改行付き sanitize 済み本文を保存し、従来 response byteを変えない', async () => {
    const baselineResponse = await relayPost(
      req('/api/relay/jpyc', freeBody()),
    );
    const baselineText = await baselineResponse.text();
    const privateMessage = '  \u0000質問\r\n次\u200b\u202e行\t  ';

    const response = await relayPost(
      req(
        '/api/relay/jpyc',
        freeBody({
          tipMessage: privateMessage,
          merchant: DECOY,
          merchantValue: (999n * JPYC).toString(),
        }),
      ),
    );
    const responseText = await response.text();
    const afterOutcomes = await settleAfterTasks();

    expect(response.status).toBe(200);
    expect(responseText).toBe(baselineText);
    expect(responseText).toBe(JSON.stringify({ ok: true, txHash: TX_HASH }));
    expect(hold.after).toHaveBeenCalledOnce();
    expect(afterOutcomes).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(hold.store).toHaveBeenCalledWith({
      from: getAddress(CUSTOMER),
      to: getAddress(MERCHANT),
      amountWei: JPYC,
      chainId: 80002,
      txHash: TX_HASH,
      message: '質問\n次行',
      ts: expect.any(Number),
    });
    expect(hold.sanitize).toHaveBeenCalledWith(privateMessage);
    expect(serializedLoggerCalls()).not.toContain(privateMessage);
  });

  it('recover success は params の権威値を保存し、raw の free用 decoy値を使わない', async () => {
    hold.forwarder = FORWARDER;
    const privateMessage = 'recover private message';

    const response = await relayPost(
      req(
        '/api/relay/jpyc',
        recoverBody({
          tipMessage: privateMessage,
          to: DECOY,
          value: (999n * JPYC).toString(),
        }),
      ),
    );
    const responseText = await response.text();
    const afterOutcomes = await settleAfterTasks();

    expect(response.status).toBe(200);
    expect(responseText).toBe(JSON.stringify({ ok: true, txHash: TX_HASH }));
    expect(afterOutcomes).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(hold.store).toHaveBeenCalledWith({
      from: getAddress(CUSTOMER),
      to: getAddress(MERCHANT),
      amountWei: 5n * JPYC,
      chainId: 80002,
      txHash: TX_HASH,
      message: privateMessage,
      ts: expect.any(Number),
    });
  });

  it('flag OFF は有効な tipMessage 付き success でも sanitize/after/store が完全 inert', async () => {
    hold.enableTipMessage = false;
    const privateMessage = 'must stay inert';

    const response = await relayPost(
      req('/api/relay/jpyc', freeBody({ tipMessage: privateMessage })),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      JSON.stringify({ ok: true, txHash: TX_HASH }),
    );
    expect(hold.sanitize).not.toHaveBeenCalled();
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.store).not.toHaveBeenCalled();
    expect(serializedLoggerCalls()).not.toContain(privateMessage);
  });

  it('fee payment でも有効な tipMessage 付き success authorization は保存する', async () => {
    const privateMessage = 'fee payment private message';

    const response = await relayPost(
      req(
        '/api/relay/jpyc',
        freeBody({ to: FEE_RECEIVER, tipMessage: privateMessage }),
      ),
    );
    const afterOutcomes = await settleAfterTasks();

    expect(response.status).toBe(200);
    expect(hold.record).not.toHaveBeenCalled();
    expect(afterOutcomes).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(hold.store).toHaveBeenCalledWith(
      expect.objectContaining({
        from: getAddress(CUSTOMER),
        to: getAddress(FEE_RECEIVER),
        amountWei: JPYC,
        message: privateMessage,
      }),
    );
  });

  it.each([
    [
      '1 JPYC 未満',
      { value: (JPYC - 1n).toString(), tipMessage: 'under minimum' },
    ],
    ['非 string', { tipMessage: { private: true } }],
    ['301 code points', { tipMessage: 'あ'.repeat(301) }],
    [
      'control/zero-width/bidi 除去後に空',
      { tipMessage: '\u0000\u200b\u202e' },
    ],
  ])('%s の message は無視して決済 response を維持する', async (_label, overrides) => {
    const response = await relayPost(
      req('/api/relay/jpyc', freeBody(overrides)),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      JSON.stringify({ ok: true, txHash: TX_HASH }),
    );
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.store).not.toHaveBeenCalled();
  });

  it.each([
    [
      'reverted',
      { kind: 'reverted', txHash: TX_HASH },
      200,
      JSON.stringify({ ok: false, reverted: true, txHash: TX_HASH }),
    ],
    [
      'rejected',
      {
        kind: 'rejected',
        reason: 'invalid_authorization',
        httpStatus: 400,
      },
      400,
      JSON.stringify({ ok: false, error: 'invalid_authorization' }),
    ],
    [
      'relay_error',
      { kind: 'relay_error', detail: 'rpc unavailable' },
      502,
      JSON.stringify({ ok: false, error: 'relay_error' }),
    ],
  ])(
    '%s result は tipMessage を保存しない',
    async (_label, relayResult, status, expectedBody) => {
      const privateMessage = `private-${_label}`;
      hold.relay.mockResolvedValue(relayResult);

      const response = await relayPost(
        req('/api/relay/jpyc', freeBody({ tipMessage: privateMessage })),
      );

      expect(response.status).toBe(status);
      expect(await response.text()).toBe(expectedBody);
      expect(hold.after).not.toHaveBeenCalled();
      expect(hold.store).not.toHaveBeenCalled();
      expect(serializedLoggerCalls()).not.toContain(privateMessage);
    },
  );

  it('pending 後の status settled 復旧でも Phase 1 は message を保存しない', async () => {
    const privateMessage = 'private-message-lost-on-pending-recovery';
    hold.relay.mockResolvedValue({ kind: 'pending', txHash: TX_HASH });

    const pendingResponse = await relayPost(
      req('/api/relay/jpyc', freeBody({ tipMessage: privateMessage })),
    );

    expect(pendingResponse.status).toBe(202);
    expect(await pendingResponse.text()).toBe(
      JSON.stringify({ ok: false, pending: true, txHash: TX_HASH }),
    );
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.store).not.toHaveBeenCalled();

    hold.idem = { state: 'hash', txHash: TX_HASH };
    const statusResponse = await statusPost(
      req('/api/relay/jpyc/status', {
        lookup: 'nonce',
        chainId: 80002,
        from: CUSTOMER,
        nonce: `0x${'3'.repeat(64)}`,
      }),
    );

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.text()).toBe(
      JSON.stringify({ ok: true, state: 'settled', txHash: TX_HASH }),
    );
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.store).not.toHaveBeenCalled();
    expect(serializedLoggerCalls()).not.toContain(privateMessage);
  });

  it.each(['false', 'reject'] as const)(
    'store が %s でも response と after callback は失敗しない',
    async (mode) => {
      const privateMessage = `private-store-${mode}`;
      if (mode === 'false') {
        hold.store.mockResolvedValue(false);
      } else {
        hold.store.mockRejectedValue(
          new Error(`KV rejected ${privateMessage}`),
        );
      }

      const response = await relayPost(
        req('/api/relay/jpyc', freeBody({ tipMessage: privateMessage })),
      );
      const responseText = await response.text();
      const afterOutcomes = await settleAfterTasks();

      expect(response.status).toBe(200);
      expect(responseText).toBe(
        JSON.stringify({ ok: true, txHash: TX_HASH }),
      );
      expect(hold.after).toHaveBeenCalledOnce();
      expect(afterOutcomes).toEqual([
        { status: 'fulfilled', value: undefined },
      ]);
      expect(hold.store).toHaveBeenCalledOnce();
      expect(serializedLoggerCalls()).not.toContain(privateMessage);
    },
  );
});
