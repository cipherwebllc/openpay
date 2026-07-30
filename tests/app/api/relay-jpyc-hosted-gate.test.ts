// creator-store v4 契約 A: recover relay 入口の hosted intent gate 配線フェンス。
// hosted 署名の recover 転用が broadcast (recoverViaForwarder) より前に閉じることを固定する。
// gate 判定本体は tests/lib/x402/purchaseSettleGate.test.ts (実導出)。
// harness は relay-jpyc-recover.test.ts と同じ境界モック構成 (hermetic 化の理由も同じ)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress } from 'viem';

vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = '0x' + '1'.repeat(64);
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY =
    '0x0F4560a777415580F0680F8B56a79B0022C6B848';
});

const JPYC_AMOY_ADDR = getAddress('0x0000000000000000000000000000000000000abc');
const FEE_RECEIVER_ADDR = getAddress('0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e');
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBytecode: () => Promise.resolve('0x60' as `0x${string}`),
      readContract: (args: { functionName: string }) => {
        if (args.functionName === 'token') return Promise.resolve(JPYC_AMOY_ADDR);
        if (args.functionName === 'feeReceiver') {
          return Promise.resolve(FEE_RECEIVER_ADDR);
        }
        return Promise.resolve(0n);
      },
      getBalance: () => Promise.resolve(0n),
      estimateGas: () => Promise.resolve(21000n),
      getTransactionCount: () => Promise.resolve(0),
    }),
  };
});

const recoverFn = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ kind: string; txHash?: string }> => ({
      kind: 'success',
      txHash: '0x' + 'ab'.repeat(32),
    }),
  ),
);
vi.mock('@/lib/relay/forwarderRecover', () => ({
  recoverViaForwarder: () => recoverFn(),
}));

vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: () => 2n * 10n ** 18n,
  recoverFeeBps: () => 0,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e',
      feeReceiverConfigured: true,
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const h = vi.hoisted(() => ({
  admission: 'allow' as 'allow' | 'denied' | 'storage',
  gate: vi.fn(),
}));

vi.mock('@/lib/x402/purchaseSettleGate', () => ({
  checkHostedIntentSettleAdmission: h.gate,
}));

import { POST } from '@/app/api/relay/jpyc/route';

const AMOY = 80002;
const JPYC = 10n ** 18n;
const CUSTOMER = '0x0000000000000000000000000000000000000def';
const MERCHANT = '0x0000000000000000000000000000000000000abc';

function payload(): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: AMOY,
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: (1_000n * JPYC).toString(),
      feeValue: (2n * JPYC).toString(),
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600),
      intentSalt: '0x' + '22'.repeat(32),
      signature: '0x' + 'b'.repeat(130),
    }),
  });
}

beforeEach(() => {
  h.admission = 'allow';
  h.gate.mockReset();
  h.gate.mockImplementation(async () => h.admission);
  recoverFn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recover relay の hosted intent gate 配線', () => {
  it('denied は 409 hosted_intent_required で broadcast へ到達しない', async () => {
    h.admission = 'denied';
    const res = await POST(payload());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'hosted_intent_required',
    });
    expect(recoverFn).not.toHaveBeenCalled();
    expect(h.gate).toHaveBeenCalledTimes(1);
  });

  it('storage は fail-closed の 503 で broadcast へ到達しない', async () => {
    h.admission = 'storage';
    const res = await POST(payload());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'storage_unavailable',
    });
    expect(recoverFn).not.toHaveBeenCalled();
  });

  it('allow (store intent 不在の salt) は従来どおり broadcast へ到達する', async () => {
    const res = await POST(payload());
    expect(res.status).toBe(200);
    expect(recoverFn).toHaveBeenCalledTimes(1);
    const arg = h.gate.mock.calls[0]![0] as {
      chainId: number;
      params: { intentSalt: string };
      signature: unknown;
    };
    expect(arg.chainId).toBe(AMOY);
    expect(arg.params.intentSalt).toBe('0x' + '22'.repeat(32));
  });
});
