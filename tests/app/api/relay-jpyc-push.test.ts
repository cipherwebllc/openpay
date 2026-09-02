import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAddress } from 'viem';

const TX_HASH = `0x${'a'.repeat(64)}`;
const MERCHANT = '0x0000000000000000000000000000000000000abc';
const CUSTOMER = '0x0000000000000000000000000000000000000def';
const FEE_RECEIVER = '0x0000000000000000000000000000000000000fee';
const FORWARDER = '0x0000000000000000000000000000000000000001';

const hold = vi.hoisted(() => ({
  enablePushNotify: true,
  forwarder: null as string | null,
  relay: vi.fn(),
  settle: vi.fn(),
  record: vi.fn(),
  notify: vi.fn(),
  after: vi.fn(),
  afterTasks: [] as Promise<unknown>[],
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: ResponseInit = {}) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
  },
  after: (cb: () => unknown) => {
    hold.after(cb);
    try {
      hold.afterTasks.push(Promise.resolve(cb()));
    } catch (e) {
      hold.afterTasks.push(Promise.reject(e));
    }
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    enableUsageFee: false,
    enableMobileOrderFee: false,
    // relay POST は status route と同じく flag + provider の双方を要求する (A5)。
    enableJpycEip3009: true,
    get enablePushNotify() {
      return hold.enablePushNotify;
    },
  },
}));

vi.mock('@/lib/kv', () => ({
  isKvConfigured: () => true,
  // settle 入口の hosted intent gate (purchaseSettleGate) が読む。null = hosted intent 不在 = 素通し。
  kvGet: vi.fn(async () => ({ ok: true, value: null })),
}));

// 月次メトリクスは after を経由するため mock で無効化 — 本 suite の after 計数フェンスは
// push 通知の after だけを対象にする (メトリクス自体は tests/lib/metrics.test.ts が検証)。
vi.mock('@/lib/metrics', () => ({
  recordMetricAfterResponse: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/billingMeter', () => ({
  recordRelayedVolume: (...args: unknown[]) => hold.record(...args),
}));

vi.mock('@/lib/feeGate', () => ({
  isGaslessRelayBlocked: vi.fn(async () => false),
}));

vi.mock('@/lib/relay/relayProvider', () => ({
  PROVIDER: 'self-host',
  MAINNET_CHAINS: new Set<number>(),
  relayMaxGasCostWei: () => 1n,
  SUPPORTED_CHAINS: { 80002: {} },
  relayFreeAuthorization: (...args: unknown[]) => hold.relay(...args),
}));

vi.mock('@/lib/relay/forwarderConfig', () => ({
  jpycForwarderFor: () => hold.forwarder,
  configuredJpycForwarderFor: () => hold.forwarder,
  isRecoverRequiredChain: () => false,
  relayGasFeeValue: () => 0n,
}));

vi.mock('@/lib/relay/forwarderSettleService', () => ({
  feeReceiverFor: () => '0x0000000000000000000000000000000000000fee',
  settleViaForwarder: (...args: unknown[]) => hold.settle(...args),
}));

vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: () => 2n,
}));

vi.mock('@/lib/mobileOrderFee', () => ({
  isMobileOrderFeeKind: () => false,
  mobileOrderFeeValue: () => 2n,
}));

vi.mock('@/lib/push/notify', () => ({
  notifyPaymentReceived: (...args: unknown[]) => hold.notify(...args),
}));

import { POST } from '@/app/api/relay/jpyc/route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function freeBody(over: Record<string, unknown> = {}) {
  return {
    chainId: 80002,
    from: CUSTOMER,
    to: MERCHANT,
    value: '1000000000000000000',
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce: `0x${'33'.repeat(32)}`,
    signature: `0x${'b'.repeat(130)}`,
    ...over,
  };
}

function recoverBody(over: Record<string, unknown> = {}) {
  return {
    chainId: 80002,
    from: CUSTOMER,
    merchant: MERCHANT,
    merchantValue: '1000000000000000000',
    feeValue: '2',
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    intentSalt: `0x${'22'.repeat(32)}`,
    signature: `0x${'b'.repeat(130)}`,
    ...over,
  };
}

async function flushAfterTasks() {
  await Promise.all(hold.afterTasks);
}

beforeEach(() => {
  hold.enablePushNotify = true;
  hold.forwarder = null;
  hold.relay.mockReset();
  hold.settle.mockReset();
  hold.record.mockReset();
  hold.notify.mockReset();
  hold.after.mockClear();
  hold.afterTasks = [];
  hold.relay.mockResolvedValue({ kind: 'success', txHash: TX_HASH });
  hold.settle.mockResolvedValue({ kind: 'success', txHash: TX_HASH });
  hold.record.mockResolvedValue(undefined);
  hold.notify.mockResolvedValue(undefined);
});

describe('POST /api/relay/jpyc push trigger', () => {
  it('free relay 成功時に after 経由で auth.to の店主へ payment 通知する', async () => {
    const res = await POST(req(freeBody()));
    await flushAfterTasks();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: TX_HASH });
    expect(hold.after).toHaveBeenCalledTimes(1);
    // value 1 JPYC (1e18) → ¥1 の金額ラベルを透過する (opt-in 購読でのみ notify 側で表示)。
    expect(hold.notify).toHaveBeenCalledWith(getAddress(MERCHANT), 'payment', '¥1');
  });

  it('relay 結果が success でなければ通知しない', async () => {
    hold.relay.mockResolvedValue({
      kind: 'rejected',
      httpStatus: 400,
      reason: 'invalid_authorization',
    });

    const res = await POST(req(freeBody()));
    await flushAfterTasks();

    expect(res.status).toBe(400);
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.notify).not.toHaveBeenCalled();
  });

  it('FEE_RECEIVER 宛の fee 支払いは通知しない', async () => {
    const res = await POST(req(freeBody({ to: FEE_RECEIVER })));
    await flushAfterTasks();

    expect(res.status).toBe(200);
    expect(hold.record).not.toHaveBeenCalled();
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.notify).not.toHaveBeenCalled();
  });

  it('flag OFF では成功しても after 自体を張らない', async () => {
    hold.enablePushNotify = false;

    const res = await POST(req(freeBody()));
    await flushAfterTasks();

    expect(res.status).toBe(200);
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.notify).not.toHaveBeenCalled();
  });

  it('recover relay 成功時は request の検証済み merchant へ payment 通知する', async () => {
    hold.forwarder = FORWARDER;

    const res = await POST(req(recoverBody()));
    await flushAfterTasks();

    expect(res.status).toBe(200);
    expect(hold.relay).not.toHaveBeenCalled();
    expect(hold.settle).toHaveBeenCalledTimes(1);
    expect(hold.after).toHaveBeenCalledTimes(1);
    // merchantValue 1 JPYC (1e18) → ¥1 の金額ラベルを透過する。
    expect(hold.notify).toHaveBeenCalledWith(getAddress(MERCHANT), 'payment', '¥1');
  });

  it('recover relay でも merchant が FEE_RECEIVER なら通知しない', async () => {
    hold.forwarder = FORWARDER;

    const res = await POST(req(recoverBody({ merchant: FEE_RECEIVER })));
    await flushAfterTasks();

    expect(res.status).toBe(200);
    expect(hold.after).not.toHaveBeenCalled();
    expect(hold.notify).not.toHaveBeenCalled();
  });
});
