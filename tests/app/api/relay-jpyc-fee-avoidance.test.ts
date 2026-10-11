// relay route handleRecover の「1% 回避」集計の配線を実 POST で検証する。
//   - 成功した gasMode=customer・feeKind なし・決済額 × 1% > フロア の件だけ、応答後 (after) に受取アドレス別の
//     KV カウンタへ足す
//   - merchant / feeKind あり (モバイル注文) / 失敗した relay は数えない
//   - after() の中で KV が throw しても、応答は数えない場合と同じ
// recoverViaForwarder は境界モック (成功/拒否を差し替える)。bps=100 (本番と同じ 1%) の料金表を模す。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress } from 'viem';
import { mobileOrderFeeValue } from '@/lib/mobileOrderFee';

vi.hoisted(() => {
  process.env.RELAYER_PRIVATE_KEY = '0x' + '1'.repeat(64);
  process.env.NEXT_PUBLIC_JPYC_FORWARDER_AMOY = '0x0F4560a777415580F0680F8B56a79B0022C6B848';
  process.env.NEXT_PUBLIC_RELAY_GAS_FEE_JPYC = '2';
});

const h = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  incrCalls: [] as Array<{ key: string; by: number }>,
  kvThrows: false,
  enableMobileOrderFee: true,
}));

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
        if (args.functionName === 'feeReceiver') return Promise.resolve(FEE_RECEIVER_ADDR);
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
    async (): Promise<Record<string, unknown>> => ({
      kind: 'success',
      txHash: '0x' + 'ab'.repeat(32),
    }),
  ),
);
vi.mock('@/lib/relay/forwarderRecover', () => ({
  recoverViaForwarder: () => recoverFn(),
}));

// 本番と同じ bps=100: merchant = max(フロア, 請求額の 1%)・customer = フロアだけ。
const JPYC = 10n ** 18n;
const FLOOR = 2n * JPYC;
vi.mock('@/lib/relay/recoverFee', () => ({
  recoverFeeValue: (billAmount: bigint, gasMode: 'customer' | 'merchant') => {
    if (gasMode === 'customer') return 2n * 10n ** 18n;
    const pct = billAmount / 100n;
    return pct > 2n * 10n ** 18n ? pct : 2n * 10n ** 18n;
  },
  recoverFeeBps: () => 100,
}));

// KV は未設定のまま (他の経路は従来どおり fail-open)。加算だけを記録する。
vi.mock('@/lib/kv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/kv')>();
  const add = (key: string, by: number) => {
    h.incrCalls.push({ key, by });
    if (h.kvThrows) throw new Error('kv transport exploded');
    return Promise.resolve({ ok: true as const, value: 1 });
  };
  return {
    ...actual,
    kvIncr: (key: string) => add(key, 1),
    kvIncrBy: (key: string, by: number) => add(key, by),
  };
});
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => void h.afterTasks.push(cb) };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      feeReceiver: '0x428483d2bd5E9f0e9f8E9f8e9F8E9F8E9f8e9F8e',
      feeReceiverConfigured: true,
      enableJpycEip3009: true,
      get enableMobileOrderFee() {
        return h.enableMobileOrderFee;
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
// checksum 形で送り、KV の key は小文字に揃うことも見る。
const MERCHANT = getAddress('0x00000000000000000000000000000000000a11ce');

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
      gasMode: 'customer',
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600),
      intentSalt: '0x' + '22'.repeat(32),
      signature: '0x' + 'b'.repeat(130),
      ...over,
    }),
  });
}

async function flushAfter(): Promise<void> {
  const tasks = h.afterTasks.splice(0);
  await Promise.all(tasks.map((task) => task()));
}

const avoidanceCalls = () => h.incrCalls.filter((c) => c.key.startsWith('relay:fee-avoid:'));

beforeEach(() => {
  h.afterTasks.length = 0;
  h.incrCalls.length = 0;
  h.kvThrows = false;
  h.enableMobileOrderFee = true;
  recoverFn.mockReset();
  recoverFn.mockResolvedValue({ kind: 'success', txHash: '0x' + 'ab'.repeat(32) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('relay route handleRecover — 1% 回避の集計 (応答後・受取アドレス別)', () => {
  it('customer・feeKind なし・1000 JPYC のチップ: 応答後に件数 1 と免れた 8 JPYC (= 800 × 0.01) を足す', async () => {
    const res = await POST(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: '0x' + 'ab'.repeat(32) });
    expect(avoidanceCalls()).toEqual([]); // 応答の時点では KV に書いていない
    await flushAfter();
    const month = new Date().toISOString().slice(0, 7);
    const base = `relay:fee-avoid:${month}:${AMOY}:${MERCHANT.toLowerCase()}`;
    expect(avoidanceCalls()).toEqual([
      { key: `${base}:count`, by: 1 },
      { key: `${base}:avoided_cjpyc`, by: 800 },
    ]);
  });

  it('merchant (決済の料金表で 1% を払った) は数えない', async () => {
    const res = await POST(
      payload({
        gasMode: 'merchant',
        merchantValue: (990n * JPYC).toString(),
        feeValue: (10n * JPYC).toString(),
      }),
    );
    expect(res.status).toBe(200);
    await flushAfter();
    expect(avoidanceCalls()).toEqual([]);
  });

  it('1% がフロア以下の小口チップ (150 JPYC) は数えない', async () => {
    const res = await POST(payload({ merchantValue: (150n * JPYC).toString() }));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(avoidanceCalls()).toEqual([]);
  });

  it('feeKind あり (モバイル注文の利用料・customer 上乗せ) は数えない', async () => {
    const fee = mobileOrderFeeValue(1_000n * JPYC, 'preorder');
    const res = await POST(payload({ feeKind: 'preorder', feeValue: fee.toString() }));
    expect(res.status).toBe(200);
    await flushAfter();
    expect(avoidanceCalls()).toEqual([]);
  });

  it('relay が成功しなかった件 (日次枠の拒否など) は数えず、拒否の応答は従来どおり', async () => {
    recoverFn.mockResolvedValue({
      kind: 'rejected',
      httpStatus: 503,
      reason: 'daily_budget_exceeded',
    });
    const res = await POST(payload());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'daily_budget_exceeded' });
    await flushAfter();
    expect(avoidanceCalls()).toEqual([]);
  });

  it('after() の中で KV が throw しても、応答は数えない場合と同じで after の処理も reject しない', async () => {
    h.kvThrows = true;
    const res = await POST(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, txHash: '0x' + 'ab'.repeat(32) });
    await expect(flushAfter()).resolves.toBeUndefined();
    expect(avoidanceCalls().length).toBeGreaterThan(0); // 実際に KV まで到達して throw した
  });
});
