// relay route handleRecover の **モバイル注文システム利用料 (feeKind)** enforcement を実 POST で検証する。
// 検証対象 = 「flag ON + 有効な feeKind (storefront/preorder) のとき、server は client 申告の率では
// なく定数表 (lib/mobileOrderFee) から expectedFee を **再計算** する」配線そのもの。
//
// 戦略: recoverFeeValue は境界モックで常にフロア (2 JPYC) を返す。一方 mobileOrderFee は **実物**
// (未モック) を使う。よって captured expectedFee が:
//   - 実 mobileOrderFeeValue (storefront=1% / preorder=3%) と一致 → route が mobile 分岐に入った証明。
//   - フロア (2 JPYC) と一致 → route が recoverFeeValue (= gas-recovery) にフォールバックした証明。
// この金額差 (大口で 1%/3% >> 2 JPYC フロア) で両分岐を曖昧さなく区別する。
//
// Amoy (testnet) forwarder を設定して recoverMode に倒す。recoverViaForwarder は境界モックし
// deps.expectedFeeValue を捕捉する (forwarder 検証/equality は別テストの担当)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress } from 'viem';
import { mobileOrderFeeValue } from '@/lib/mobileOrderFee';

// 1. relayer self-host を有効化 + Amoy forwarder を設定 (import 前に env を立てる)。
vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = '0x' + '1'.repeat(64);
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY =
    '0x0F4560a777415580F0680F8B56a79B0022C6B848';
});

// flag をテスト毎に切替可能にする (getter)。既定は ON (本テストの主対象が flag ON 経路のため)。
const flags = vi.hoisted(() => ({ enableMobileOrderFee: true }));

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
        if (args.functionName === 'feeReceiver')
          return Promise.resolve(FEE_RECEIVER_ADDR);
        return Promise.resolve(0n);
      },
      getBalance: () => Promise.resolve(0n),
      estimateGas: () => Promise.resolve(21000n),
      getTransactionCount: () => Promise.resolve(0),
    }),
  };
});

// 2. recoverViaForwarder を境界モック (deps.expectedFeeValue を捕捉)。
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

// 3. recoverFeeValue (gas-recovery) は境界モックで常にフロア (2 JPYC)。mobile 分岐に入れば
//    こちらは **呼ばれない** (= captured expectedFee が実 mobileOrderFeeValue になる)。
const JPYC = 10n ** 18n;
const FLOOR = 2n * JPYC;
const recoverFeeMock = vi.fn(() => FLOOR);
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: () => recoverFeeMock(),
  recoverFeeBps: () => 0,
}));

// 4. env: feeReceiver を確定 + enableMobileOrderFee を getter で可変に。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e',
      feeReceiverConfigured: true,
      get enableMobileOrderFee() {
        return flags.enableMobileOrderFee;
      },
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

// 注文 1000 JPYC を基準に payload を組む。
// - merchant (店舗負担): merchantValue = order - fee, feeValue = fee → billAmount = mv + fv = order。
// - customer (顧客上乗せ): merchantValue = order, feeValue = fee → billAmount = mv = order。
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
  flags.enableMobileOrderFee = true;
  recoverFeeMock.mockClear();
  recoverFn.mockClear();
  recoverFn.mockResolvedValue({ kind: 'success', txHash: '0x' + 'ab'.repeat(32) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('relay route — モバイル注文 feeKind enforcement (server 権威・定数表 再計算)', () => {
  const ORDER = 1_000n * JPYC;

  it('flag ON + feeKind=storefront (店舗負担): expectedFee = 実 mobileOrderFeeValue 1% (= 10 JPYC, floor ではない)', async () => {
    const fee = mobileOrderFeeValue(ORDER, 'storefront'); // 実 1% = 10 JPYC
    expect(fee).toBe(10n * JPYC); // sanity: floor(2) と区別できる額
    const res = await POST(
      payload({
        gasMode: 'merchant',
        merchantValue: (ORDER - fee).toString(),
        feeValue: fee.toString(),
        feeKind: 'storefront',
      }),
    );
    expect(res.status).toBe(200);
    // server は billAmount=mv+fv=1000 JPYC から mobileOrderFeeValue(storefront)=10 を再計算。
    expect(capturedExpectedFee).toBe(fee);
    // gas-recovery (recoverFeeValue) は呼ばれない (mobile 分岐に入った証明)。
    expect(recoverFeeMock).not.toHaveBeenCalled();
  });

  it('flag ON + feeKind=preorder (顧客上乗せ): expectedFee = 実 mobileOrderFeeValue 3% (= 30 JPYC)', async () => {
    const fee = mobileOrderFeeValue(ORDER, 'preorder'); // 実 3% = 30 JPYC
    expect(fee).toBe(30n * JPYC);
    const res = await POST(
      payload({
        gasMode: 'customer',
        merchantValue: ORDER.toString(), // customer: 店舗は満額・billAmount = mv
        feeValue: fee.toString(),
        feeKind: 'preorder',
      }),
    );
    expect(res.status).toBe(200);
    expect(capturedExpectedFee).toBe(fee);
    expect(recoverFeeMock).not.toHaveBeenCalled();
  });

  it('flag ON + feeKind=preorder 小口: 3% がフロアを下回っても 一律 % (floor に張り付かない)', async () => {
    const small = 50n * JPYC; // 3% = 1.5 JPYC < floor 2 JPYC
    const fee = mobileOrderFeeValue(small, 'preorder');
    expect(fee).toBe((small * 3n) / 100n); // = 1.5 JPYC
    expect(fee).toBeLessThan(FLOOR); // フロアを下回る (mobile はフロア無し)
    const res = await POST(
      payload({
        gasMode: 'customer',
        merchantValue: small.toString(),
        feeValue: fee.toString(),
        feeKind: 'preorder',
      }),
    );
    expect(res.status).toBe(200);
    // mobile は一律 % ゆえ floor に持ち上げない (= recoverFeeValue とは異なる挙動)。
    expect(capturedExpectedFee).toBe(fee);
    expect(recoverFeeMock).not.toHaveBeenCalled();
  });

  it('flag OFF + feeKind=storefront: feeKind 無視 → recoverFeeValue (gas-recovery floor) にフォールバック', async () => {
    flags.enableMobileOrderFee = false;
    const res = await POST(
      payload({
        gasMode: 'merchant',
        merchantValue: (ORDER - 10n * JPYC).toString(),
        feeValue: (10n * JPYC).toString(),
        feeKind: 'storefront',
      }),
    );
    expect(res.status).toBe(200);
    // flag OFF: server は mobile を見ず recoverFeeValue (= floor 2 JPYC) を使う。
    expect(recoverFeeMock).toHaveBeenCalled();
    expect(capturedExpectedFee).toBe(FLOOR);
  });

  it("flag ON + feeKind='register' (非 mobile kind): isMobileOrderFeeKind=false → recoverFeeValue にフォールバック", async () => {
    // register は relay には送られない設計だが、防御的に POST しても mobile 扱いされない。
    const res = await POST(
      payload({
        gasMode: 'merchant',
        merchantValue: (ORDER - 10n * JPYC).toString(),
        feeValue: (10n * JPYC).toString(),
        feeKind: 'register',
      }),
    );
    expect(res.status).toBe(200);
    expect(recoverFeeMock).toHaveBeenCalled();
    expect(capturedExpectedFee).toBe(FLOOR);
  });

  it('flag ON + feeKind=bogus (不正値): 無視 → recoverFeeValue にフォールバック', async () => {
    const res = await POST(
      payload({
        gasMode: 'merchant',
        merchantValue: (ORDER - 10n * JPYC).toString(),
        feeValue: (10n * JPYC).toString(),
        feeKind: 'bogus',
      }),
    );
    expect(res.status).toBe(200);
    expect(recoverFeeMock).toHaveBeenCalled();
    expect(capturedExpectedFee).toBe(FLOOR);
  });

  it('flag ON + feeKind 無し (通常の /checkout・/pay): 従来の recoverFeeValue を使う (不変)', async () => {
    const res = await POST(payload({ gasMode: 'merchant' }));
    expect(res.status).toBe(200);
    expect(recoverFeeMock).toHaveBeenCalled();
    expect(capturedExpectedFee).toBe(FLOOR);
  });
});
