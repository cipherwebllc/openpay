// relay route handleRecover の **手数料配線** を実 POST で検証する。
// 検証対象 = 「route が payload の gasMode + (merchantValue, feeValue) から billAmount を再構成し、
// recoverFeeValue(billAmount) を expectedFeeValue として forwarderRecover に渡す」配線そのもの。
// recoverViaForwarder の中身 (feeValue===expectedFeeValue の equality 等) は forwarderRecover.test.ts
// で別途検証済みなので、ここでは recoverViaForwarder を境界モックし deps.expectedFeeValue を捕捉する。
// recoverFeeValue も境界モック (env 再評価を避け、route が billAmount を正しく組み立てるかだけを見る)。
//
// Amoy (testnet) forwarder を設定して recoverMode に倒す (mainnet hardening の KV/gas-ceiling を回避)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1. relayer self-host を有効化 + Amoy forwarder を設定 (import 前に env を立てる)。
vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = '0x' + '1'.repeat(64);
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY =
    '0x0F4560a777415580F0680F8B56a79B0022C6B848';
});

// 2. recoverViaForwarder を境界モック (deps.expectedFeeValue を捕捉)。実コアは forwarderRecover.test。
const recoverFn = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ kind: string; txHash?: string }> => ({
      kind: 'success',
      txHash: '0x' + 'ab'.repeat(32),
    }),
  ),
);
let capturedExpectedFee: bigint | undefined;
vi.mock('@/lib/relay/forwarderRecover', () => ({
  recoverViaForwarder: (
    _input: unknown,
    deps: { expectedFeeValue: bigint },
  ) => {
    capturedExpectedFee = deps.expectedFeeValue;
    return recoverFn();
  },
}));

// 3. recoverFeeValue を境界モック (bps を実 env 無しで制御)。既定 bps=0 を模す: 常にフロア 2 JPYC。
//    各テストで recoverFeeImpl を差し替えて bps>0 のケースを表現する。client/server は同式を使う前提
//    なので、ここでは route が *どの billAmount で recoverFeeValue を呼ぶか* を捕捉して検証する。
const JPYC = 10n ** 18n;
const FLOOR = 2n * JPYC;
let recoverFeeImpl: (billAmount: bigint) => bigint = () => FLOOR;
let lastBillAmount: bigint | undefined;
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: (billAmount: bigint) => {
    lastBillAmount = billAmount;
    return recoverFeeImpl(billAmount);
  },
  recoverFeeBps: () => 0,
}));

// 4. feeReceiver を確定 (route の feeReceiverFor が env.feeReceiver を読む)。有効な checksum を使う。
//    リテラルは vi.mock factory の hoist 内で完結させる (top-level const 参照は初期化前で不可)。
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

import { POST } from '@/app/api/relay/jpyc/route';

const AMOY = 80002;
const CUSTOMER = '0x0000000000000000000000000000000000000def';
const MERCHANT = '0x0000000000000000000000000000000000000abc';

function payload(over: Record<string, unknown> = {}): Request {
  return new Request('http://localhost/api/relay/jpyc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: AMOY,
      from: CUSTOMER,
      merchant: MERCHANT,
      merchantValue: (1_000n * JPYC).toString(),
      feeValue: FLOOR.toString(),
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600),
      intentSalt: '0x' + '22'.repeat(32),
      signature: '0x' + 'b'.repeat(130),
      ...over,
    }),
  });
}

beforeEach(() => {
  capturedExpectedFee = undefined;
  lastBillAmount = undefined;
  recoverFeeImpl = () => FLOOR; // 既定 bps=0 相当 (常にフロア)
  recoverFn.mockClear();
  recoverFn.mockResolvedValue({ kind: 'success', txHash: '0x' + 'ab'.repeat(32) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('relay route handleRecover — billAmount 再構成 + expectedFee 配線', () => {
  it('bps=0 (既定): gasMode=customer → expectedFeeValue=フロア 2e18 (現行挙動)', async () => {
    const res = await POST(payload({ gasMode: 'customer' }));
    expect(res.status).toBe(200);
    expect(capturedExpectedFee).toBe(FLOOR);
    // customer: billAmount == merchantValue。
    expect(lastBillAmount).toBe(1_000n * JPYC);
  });

  it('bps=0 (既定): gasMode=merchant → billAmount=merchantValue+feeValue, expectedFeeValue=フロア', async () => {
    const res = await POST(
      payload({ gasMode: 'merchant', merchantValue: (998n * JPYC).toString() }),
    );
    expect(res.status).toBe(200);
    expect(capturedExpectedFee).toBe(FLOOR);
    // merchant: billAmount == merchantValue + feeValue == 998 + 2 = 1000 JPYC。
    expect(lastBillAmount).toBe(1_000n * JPYC);
  });

  it('gasMode 欠落 (旧 client) → customer 既定で処理 (400 にしない)', async () => {
    // payload() は gasMode を含まない既定 body を作る (over で足さない)。
    const res = await POST(payload());
    expect(res.status).toBe(200);
    // 既定 customer: billAmount == merchantValue。
    expect(lastBillAmount).toBe(1_000n * JPYC);
  });

  it('不正 gasMode は customer に倒す (billAmount=merchantValue・400 にしない)', async () => {
    const res = await POST(
      payload({ gasMode: 'bogus', merchantValue: (1_000n * JPYC).toString() }),
    );
    expect(res.status).toBe(200);
    expect(lastBillAmount).toBe(1_000n * JPYC);
  });

  it('bps=100 相当: gasMode=customer, merchantValue=1000 JPYC → expectedFee=1% =10e18', async () => {
    recoverFeeImpl = (b) => {
      const pct = (b * 100n) / 10000n;
      return pct > FLOOR ? pct : FLOOR;
    };
    const res = await POST(
      payload({ gasMode: 'customer', merchantValue: (1_000n * JPYC).toString() }),
    );
    expect(res.status).toBe(200);
    expect(lastBillAmount).toBe(1_000n * JPYC);
    expect(capturedExpectedFee).toBe(10n * JPYC);
  });

  it('bps=100 相当: gasMode=merchant, mv=990 fv=10 → billAmount=1000 JPYC, expectedFee=10e18', async () => {
    recoverFeeImpl = (b) => {
      const pct = (b * 100n) / 10000n;
      return pct > FLOOR ? pct : FLOOR;
    };
    const res = await POST(
      payload({
        gasMode: 'merchant',
        merchantValue: (990n * JPYC).toString(),
        feeValue: (10n * JPYC).toString(),
      }),
    );
    expect(res.status).toBe(200);
    // 店舗吸収: server は billAmount = mv + fv = 990 + 10 = 1000 JPYC を再構成。
    expect(lastBillAmount).toBe(1_000n * JPYC);
    expect(capturedExpectedFee).toBe(10n * JPYC);
  });

  it('bps=100 相当・小口: customer, merchantValue=100 JPYC → 1% =1 JPYC < フロア → expectedFee=フロア', async () => {
    recoverFeeImpl = (b) => {
      const pct = (b * 100n) / 10000n;
      return pct > FLOOR ? pct : FLOOR;
    };
    const res = await POST(
      payload({ gasMode: 'customer', merchantValue: (100n * JPYC).toString() }),
    );
    expect(res.status).toBe(200);
    expect(lastBillAmount).toBe(100n * JPYC);
    expect(capturedExpectedFee).toBe(FLOOR);
  });
});
