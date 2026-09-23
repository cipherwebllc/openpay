import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { encodeEventTopics, erc20Abi, padHex, toHex } from 'viem';
import type { FeeReceiptLog } from '@/lib/feeVerify';
import { resolveDeployment } from '@/lib/tokens';

const WALLET = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const RECEIVER = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TXHASH = `0x${'1'.repeat(64)}`;
const CHAIN = 80002;
const NOW_SEC = 1_750_000_000;
const JPYC = 10n ** 18n;
const SEVEN_DAYS_SEC = 7 * 86_400;
const OTHER = '0x1111111111111111111111111111111111111111';

// Exercise both real routes, the capped reader, payment engine and fee verifier.
// Only authentication, RPC and persistence are mocked; no wallet or network is used.
const h = vi.hoisted(() => ({
  enabled: true,
  configured: true,
  authenticated: true,
  nowMs: 1_750_000_000_000,
  blockTimestampSec: 1_750_000_000,
  value: 0n,
  extraLogs: [] as FeeReceiptLog[],
  session: vi.fn(),
  receipt: vi.fn(),
  getBlock: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  eval: vi.fn(),
  grant: vi.fn(),
  revenue: vi.fn(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      get enablePro() { return h.enabled; },
      get enableCsvPass() { return h.enabled; },
      get feeReceiverConfigured() { return h.configured; },
    },
  };
});
vi.mock('@/app/api/auth/siwe/_session', () => ({ requireSession: h.session }));
vi.mock('viem', async (importOriginal) => ({
  ...await importOriginal<typeof import('viem')>(),
  createPublicClient: () => ({
    getTransactionReceipt: h.receipt,
    getBlock: h.getBlock,
  }),
}));
vi.mock('@/lib/kv', () => ({
  kvSet: h.set,
  kvGet: vi.fn(),
  kvDel: h.del,
  kvEval: h.eval,
}));
vi.mock('@/lib/proPlan', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/proPlan')>(),
  grantPro: h.grant,
}));
vi.mock('@/lib/csvPass', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/csvPass')>(),
  grantCsvPass: h.grant,
}));
vi.mock('@/lib/proRevenue', () => ({ recordProRevenue: h.revenue }));
vi.mock('@/lib/csvPassRevenue', () => ({ recordCsvPassRevenue: h.revenue }));

import { POST as proPost } from '@/app/api/pro/subscribe/route';
import { POST as csvPost } from '@/app/api/csv-pass/subscribe/route';

function request(body = JSON.stringify({ txHash: TXHASH, chainId: CHAIN })) {
  return new Request('http://localhost/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function paddedBody(size: number) {
  const body = JSON.stringify({ txHash: TXHASH, chainId: CHAIN });
  return body + ' '.repeat(size - body.length);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.configured = true;
  h.authenticated = true;
  h.nowMs = NOW_SEC * 1000;
  h.extraLogs = [];
  h.blockTimestampSec = NOW_SEC;
  vi.spyOn(Date, 'now').mockImplementation(() => h.nowMs);
  h.session.mockImplementation(async () => h.authenticated
    ? { ok: true, address: WALLET }
    : { ok: false, response: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) });
  h.receipt.mockImplementation(async () => ({
    status: 'success',
    blockNumber: 42n,
    logs: [{
      address: resolveDeployment('jpyc', CHAIN)!.address,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: WALLET, to: RECEIVER },
      }),
      data: padHex(toHex(h.value), { size: 32 }),
    }, ...h.extraLogs],
  }));
  h.getBlock.mockImplementation(async () => ({ timestamp: BigInt(h.blockTimestampSec) }));
  h.set.mockResolvedValue({ ok: true, value: 'OK' });
  h.del.mockResolvedValue({ ok: true, value: 1 });
  h.eval.mockResolvedValue({ ok: true, value: 1 });
  h.grant.mockImplementation(async (_wallet, expiresAt) => ({ ok: true, expiresAt }));
  h.revenue.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe.each([
  { tier: 'pro', post: proPost, price: 500n * JPYC, grantMs: 30 * 86_400_000 },
  { tier: 'csvpass', post: csvPost, price: 100n * JPYC, grantMs: 86_400_000 },
])('$tier subscribe payment/body validation', ({ tier, post, price, grantMs }) => {
  beforeEach(() => { h.value = price; });

  it.each([-1n, 1n, 50n * JPYC])('rejects a payment differing from the price by %s wei', async (delta) => {
    h.value = price + delta;
    const res = await post(request());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'insufficient_payment' });
    expect(h.del).toHaveBeenCalledWith(`${tier}:used:${CHAIN}:${TXHASH}`);
    expect(h.eval).not.toHaveBeenCalled();
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.revenue).not.toHaveBeenCalled();
  });

  it.each([
    { ageSec: SEVEN_DAYS_SEC + 1, error: 'payment_too_old' },
    { ageSec: -61, error: 'payment_in_future' },
  ])('rejects a block outside the request window: $ageSec seconds old', async ({ ageSec, error }) => {
    h.blockTimestampSec = NOW_SEC - ageSec;
    const res = await post(request());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error });
    expect(h.del).toHaveBeenCalledWith(`${tier}:used:${CHAIN}:${TXHASH}`);
    expect(h.eval).not.toHaveBeenCalled();
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.revenue).not.toHaveBeenCalled();
  });

  it.each([0, SEVEN_DAYS_SEC, -60])('accepts exact payment at the inclusive time boundary: %s seconds old', async (ageSec) => {
    h.blockTimestampSec = NOW_SEC - ageSec;
    const res = await post(request());
    expect(res.status).toBe(200);
    expect(h.grant).toHaveBeenCalledWith(WALLET, h.blockTimestampSec * 1000 + grantMs);
    expect(h.revenue).toHaveBeenCalledWith({
      wallet: WALLET, priceWei: price, chainId: CHAIN, txHash: TXHASH,
      paidAtMs: h.blockTimestampSec * 1000,
    });
  });

  it('anchors recency before authentication/RPC delays', async () => {
    h.blockTimestampSec = NOW_SEC - SEVEN_DAYS_SEC;
    h.session.mockImplementationOnce(async () => {
      h.nowMs += 120_000;
      return { ok: true, address: WALLET };
    });
    expect((await post(request())).status).toBe(200);
  });

  it.each(['rpc', 'grant'])('同じ txHash を障害 (%s) の翌日に再提出して付与できる', async (failure) => {
    if (failure === 'rpc') h.getBlock.mockRejectedValueOnce(new Error('rpc down'));
    else h.grant.mockResolvedValueOnce({ ok: false, expiresAt: 0 });
    expect((await post(request())).status).toBe(503);
    h.nowMs += 86_400_000;
    h.grant.mockClear();
    const res = await post(request());
    expect(res.status).toBe(200);
    expect(h.receipt).toHaveBeenLastCalledWith({ hash: TXHASH });
    expect(h.grant).toHaveBeenCalledWith(WALLET, NOW_SEC * 1000 + grantMs);
    expect(h.revenue).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'merchant payment before fee', from: WALLET, to: OTHER, prepend: true },
    { label: 'merchant payment after fee', from: WALLET, to: OTHER, prepend: false },
    { label: 'another payer to receiver', from: OTHER, to: RECEIVER, prepend: false },
    { label: 'receiver outgoing transfer', from: RECEIVER, to: OTHER, prepend: false },
  ] as const)('JPYC の別用途 Transfer を含む receipt を拒否: $label', async ({ from, to, prepend }) => {
    h.extraLogs = [{
      address: resolveDeployment('jpyc', CHAIN)!.address,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as string[],
      data: padHex(toHex(10_000n * JPYC), { size: 32 }),
    }];
    if (prepend) {
      const receipt = await h.receipt();
      receipt.logs.reverse();
      h.receipt.mockResolvedValueOnce(receipt);
    }
    const res = await post(request());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false, error: 'insufficient_payment', reason: 'unexpected_transfer',
    });
    expect(h.del).toHaveBeenCalledWith(`${tier}:used:${CHAIN}:${TXHASH}`);
    expect(h.eval).not.toHaveBeenCalled();
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.revenue).not.toHaveBeenCalled();
  });

  it('別 token の Transfer と JPYC の非 Transfer イベントは許可', async () => {
    h.extraLogs = [{
      address: OTHER,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: WALLET, to: OTHER } }) as string[],
      data: padHex(toHex(10_000n * JPYC), { size: 32 }),
    }, {
      address: resolveDeployment('jpyc', CHAIN)!.address,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Approval', args: { owner: WALLET, spender: OTHER } }) as string[],
      data: padHex(toHex(price), { size: 32 }),
    }];
    expect((await post(request())).status).toBe(200);
    expect(h.receipt).toHaveBeenCalledOnce();
  });

  it('null JSON → 400 invalid_json・認証後の TypeError/KV/RPC を起こさない', async () => {
    const res = await post(request('null'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' });
    expect(h.set).not.toHaveBeenCalled();
    expect(h.receipt).not.toHaveBeenCalled();
  });

  it.each([undefined, '2'])('caps 4097 bytes even with Content-Length=%s', async (length) => {
    const req = request(paddedBody(4097));
    if (length !== undefined) req.headers.set('content-length', length);
    const res = await post(req);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'payload_too_large' });
    expect(h.set).not.toHaveBeenCalled();
    expect(h.receipt).not.toHaveBeenCalled();
    expect(h.grant).not.toHaveBeenCalled();
  });

  it('accepts a valid body exactly 4096 bytes long', async () => {
    expect((await post(request(paddedBody(4096)))).status).toBe(200);
    expect(h.grant).toHaveBeenCalledOnce();
  });

  it('counts streamed UTF-8 bytes cumulatively and cancels after the cap', async () => {
    const cancel = vi.fn();
    const json = JSON.stringify({ txHash: TXHASH, chainId: CHAIN, extra: 'あ'.repeat(1400) });
    expect(json.length).toBeLessThan(4096);
    const bytes = new TextEncoder().encode(json);
    let offset = 0;
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 1024, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
        cancel,
      }, { highWaterMark: 0 }),
    };
    const req = new Request('http://localhost/api/subscribe', init);
    const res = await post(req);
    expect(res.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.receipt).not.toHaveBeenCalled();
  });

  it.each([
    { gate: 'flag', status: 404, error: `${tier}_disabled` },
    { gate: 'config', status: 503, error: `${tier}_misconfigured` },
    { gate: 'auth', status: 401, error: 'unauthenticated' },
  ])('keeps $gate responses ahead of body consumption', async ({ gate, status, error }) => {
    h.enabled = gate !== 'flag';
    h.configured = gate !== 'config';
    h.authenticated = gate !== 'auth';
    const req = request(paddedBody(4097));
    const res = await post(req);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: false, error });
    expect(req.bodyUsed).toBe(false);
    if (gate !== 'auth') expect(h.session).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.receipt).not.toHaveBeenCalled();
  });
});
