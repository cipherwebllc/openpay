// hooks/useQrBillKey.ts: 見張りの chunk (lib/qrSaleWatch.ts) の読み込みが遅く、QR を閉じた後に読み込みが終わるとき。
// 表示を始めた時刻・やめた時刻は画面の側がその瞬間に決めて渡すので、60 秒は閉じた時刻から数える (読み込みが終わった時刻
// からではない)。読み込みが終わった時点で、閉じてから 60 秒を過ぎていた会計は持たない。
// 見張りは本物 (読み込みだけを止めておける)。RPC (lib/qrSaleRpc.ts) だけを差し替える。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Address } from 'viem';

const hold = vi.hoisted(() => {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open(), calls: [] as [string, number][] };
});
const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn() }));
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
}));
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: () => '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
}));
// 見張りの chunk の読み込みを、テストが開けるまで止める。画面の側が渡した時刻を記録する。
vi.mock('@/lib/qrSaleWatch', async (importOriginal) => {
  await hold.gate;
  const actual = await importOriginal<typeof import('@/lib/qrSaleWatch')>();
  return {
    ...actual,
    showQrBill: (...args: Parameters<typeof actual.showQrBill>) => {
      hold.calls.push([`show:${args[0].billKey}`, args[1]]);
      actual.showQrBill(...args);
    },
    hideQrBill: (...args: Parameters<typeof actual.hideQrBill>) => {
      hold.calls.push([`hide:${args[0]}`, args[1]]);
      actual.hideQrBill(...args);
    },
  };
});

import { useQrBillKey } from '@/hooks/useQrBillKey';
import { loadHistory } from '@/lib/history';
import { readQrBill } from '@/lib/qrSaleHistory';
import { buildPayUrl } from '@/lib/url';
import { billNonce, settledRpcLog } from '../_helpers/qrSale';

const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const T0 = Date.UTC(2026, 10, 17, 3, 0, 0);
const URL_A = buildPayUrl('https://shop.test', {
  to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', receiptNo: 'A',
});
const URL_B = buildPayUrl('https://shop.test', {
  to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', receiptNo: 'B',
});
const keyOf = (screenUrl: string | undefined) => /&bk=([A-Za-z0-9_-]{11})$/.exec(screenUrl ?? '')![1];
// 見張りの chunk の読み込み (Promise) を待つ (実時間・時計は進めない)。
async function waitForCalls(count: number) {
  for (let i = 0; i < 100 && hold.calls.length < count; i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(hold.calls).toHaveLength(count);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
  window.localStorage.clear();
  rpc.head.mockReset().mockResolvedValue(1_000n);
  rpc.logs.mockReset().mockResolvedValue([]);
  rpc.time.mockReset();
});
afterEach(async () => {
  (await import('@/lib/qrSaleWatch')).stopQrSaleWatch();
  vi.useRealTimers();
});

describe('useQrBillKey — 見張りの読み込みが、QR を閉じた後に終わる', () => {
  it('60 秒は閉じた時刻から数える。読み込みが終わった時に閉じて 60 秒を過ぎていた会計は持たない', async () => {
    // QR A: T0 に出して 5 秒後に閉じる。QR B: 20 秒後に出して 25 秒後に閉じる。どちらも見張りの読み込み待ちのまま。
    const a = renderHook((p: { shown: boolean }) => useQrBillKey({ kind: 'pay', url: URL_A, shown: p.shown }), {
      initialProps: { shown: true },
    });
    const keyA = keyOf(a.result.current);
    vi.setSystemTime(T0 + 5_000);
    a.rerender({ shown: false });
    vi.setSystemTime(T0 + 20_000);
    const b = renderHook((p: { shown: boolean }) => useQrBillKey({ kind: 'pay', url: URL_B, shown: p.shown }), {
      initialProps: { shown: true },
    });
    const keyB = keyOf(b.result.current);
    vi.setSystemTime(T0 + 25_000);
    b.rerender({ shown: false });

    // 読み込みが終わるのは T0 + 70 秒 (A は閉じて 65 秒・B は閉じて 45 秒)。
    vi.setSystemTime(T0 + 70_000);
    hold.open();
    await waitForCalls(4);
    // 見張りに渡った時刻は、表示を始めた瞬間・やめた瞬間 (読み込みが終わった時刻ではない)。
    expect(hold.calls).toEqual([
      [`show:${keyA}`, T0],
      [`hide:${keyA}`, T0 + 5_000],
      [`show:${keyB}`, T0 + 20_000],
      [`hide:${keyB}`, T0 + 25_000],
    ]);

    // チェーンには、それぞれの会計が生きていた間に取り込まれた、その bill key の支払い (A: T0 + 2 秒・B: T0 + 22 秒)。
    const payment = (billKey: string, url: string, block: bigint, at: number, tx: string) => {
      const bill = readQrBill({ billKey, kind: 'pay', url, itemName: '' })!;
      const sale = {
        from: CUSTOMER, merchant: SHOP, ...bill.expected, validBefore: BigInt(at / 1000) + 290n,
        chainId: bill.chainId, forwarder: FORWARDER,
      };
      return { log: settledRpcLog({ ...sale, nonce: billNonce(billKey, sale), txHash: tx, blockNumber: block }), block, at };
    };
    const paid = [
      payment(keyA, URL_A, 990n, T0 + 2_000, `0x${'a1'.repeat(32)}`),
      payment(keyB, URL_B, 991n, T0 + 22_000, `0x${'b1'.repeat(32)}`),
    ];
    rpc.logs.mockResolvedValue(paid.map((p) => p.log));
    rpc.time.mockImplementation(async (_chainId: number, block: bigint) =>
      BigInt(paid.find((p) => p.block === block)!.at / 1000),
    );

    // 見張りの回: T0 + 76 秒 (B は閉じて 51 秒)・T0 + 82 秒 (57 秒) は読み、T0 + 88 秒 (63 秒) で B も捨てて止まる。
    await vi.advanceTimersByTimeAsync(6_000);
    expect(rpc.head).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000 * 4);
    expect(rpc.head).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    // 行になるのは B の支払いだけ (A の会計は持っていない)。
    expect(loadHistory().map((e) => [e.txHash, e.receiptNo])).toEqual([[`0x${'b1'.repeat(32)}`, 'B']]);
  });
});
