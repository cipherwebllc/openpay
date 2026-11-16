// lib/orderFeedHistoryRecorder.ts: 受注フィードの注文を、履歴に 1 件 1 行・1 回だけ書く。
// receipt の読み取り (lib/orderFeedReceipt.ts) だけを差し替え、履歴 (localStorage) は実物。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Address, Hex } from 'viem';
import { recoverReceipt } from '../_helpers/orderSaleReceipt';

const read = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orderFeedReceipt', () => ({
  ORDER_RECEIPT_TIMEOUT_MS: 6_000,
  readOrderReceipt: read,
}));
vi.mock('@/lib/relay/forwarderConfig', async () => {
  const actual = await vi.importActual<typeof import('@/lib/relay/forwarderConfig')>('@/lib/relay/forwarderConfig');
  return { ...actual, configuredJpycForwarderFor: vi.fn(() => '0x1111111111111111111111111111111111111111') };
});
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableMobileOrderFee: true } };
});
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } }));
// 履歴は実物。読んだ回数・書いた回数を数え、保存の失敗を差し込めるようにだけする。
const historyHold = vi.hoisted(() => ({ failAppend: false, loads: 0, appends: 0 }));
vi.mock('@/lib/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/history')>();
  return {
    ...actual,
    loadHistory: () => {
      historyHold.loads += 1;
      return actual.loadHistory();
    },
    appendHistory: (entry: Parameters<typeof actual.appendHistory>[0]) => {
      historyHold.appends += 1;
      if (historyHold.failAppend) throw new Error('storage_broken');
      actual.appendHistory(entry);
    },
  };
});

import { env } from '@/lib/env';
import { appendHistory, buildHistoryEntry, loadHistory } from '@/lib/history';
import {
  ORDER_RECEIPT_MAX_READS,
  ORDER_RECEIPT_READS_PER_PASS,
  createOrderSaleRecorder,
} from '@/lib/orderFeedHistoryRecorder';
import type { StoredOrder } from '@/lib/orderRelay';
import { deploymentForSlug } from '@/lib/tokens';

const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const MERCHANT: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER_MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const JPYC = deploymentForSlug('jpyc', 'polygon');
const ONE = 10n ** 18n;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function order(n: number, over: Partial<StoredOrder> = {}): StoredOrder {
  return {
    orderId: `N${n}`,
    items: [{ name: '水', qty: 1, price: '1000' }],
    table: null,
    amount: (990n * ONE).toString(),
    txHash: tx(n),
    chainId: JPYC.chainId,
    from: '',
    ts: 1_763_000_000_000 + n * 1_000,
    fulfilled: false,
    ...over,
  };
}

const receipt = (merchant: Address = MERCHANT) =>
  recoverReceipt({
    token: JPYC.address, forwarder: FORWARDER, customer: CUSTOMER, merchant,
    merchantValue: 990n * ONE, feeReceiver: env.feeReceiver, feeValue: 10n * ONE,
  });

beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async () => receipt());
  historyHold.failAppend = false;
  historyHold.loads = 0;
  historyHold.appends = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createOrderSaleRecorder — 1 件 1 行・1 回だけ', () => {
  it('新しい注文で 1 行。次の polling でも 1 行のまま (履歴も receipt も読み直さない)', async () => {
    const record = createOrderSaleRecorder();
    const orders = [order(1)];
    await record(orders, MERCHANT);
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0]).toMatchObject({
      id: `batch-${tx(1)}`, merchant: MERCHANT, customer: CUSTOMER, status: 'success',
      merchantAmount: (990n * ONE).toString(), feeAmount: (10n * ONE).toString(), saleAmount: (1_000n * ONE).toString(),
      receiptNo: 'N1',
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(JPYC.chainId, tx(1));
    const loadsAfterFirst = historyHold.loads;

    await record(orders, MERCHANT);
    await record([...orders], MERCHANT); // 中身が同じ別の配列 (polling の応答)
    expect(read).toHaveBeenCalledTimes(1);
    expect(historyHold.appends).toBe(1);
    // 決着した注文しか無い polling では、履歴 (上限 1,000 件) を parse しない。
    expect(historyHold.loads).toBe(loadsAfterFirst);
    expect(loadHistory()).toHaveLength(1);
  });

  it('新しく届いた注文だけを足す (前の注文は読み直さない)', async () => {
    const record = createOrderSaleRecorder();
    await record([order(1)], MERCHANT);
    await record([order(2), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2', 'N1']);
    expect(read.mock.calls.map(([, hash]) => hash)).toEqual([tx(1), tx(2)]);
  });

  it('同じ txHash の行が履歴にあれば何もしない (receipt も読まない)。払った側が同じ端末で書いた行でも、flow や大文字小文字が違っても', async () => {
    const payerRow = buildHistoryEntry({
      flow: 'batch', status: 'success', chainId: JPYC.chainId, chainSlug: 'polygon', asset: 'jpyc',
      tokenAddress: JPYC.address, payMode: 'gasless', gasMode: 'merchant', merchant: MERCHANT,
      merchantAmount: 990n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 10n * ONE,
      txHash: tx(0xabc).toUpperCase().replace('0X', '0x'), userOpHash: null, blockNumber: null, errorMessage: null,
      storeName: '', note: '払った側が書いた行',
    });
    appendHistory(payerRow);
    historyHold.appends = 0;
    const record = createOrderSaleRecorder();
    await record([order(0xabc), order(0xabc, { unboundPayment: true })], MERCHANT);
    await record([order(0xabc)], MERCHANT);
    expect(read).not.toHaveBeenCalled();
    expect(historyHold.appends).toBe(0);
    expect(loadHistory()).toEqual([payerRow]);
  });

  it('txHash の無い注文・形の崩れた注文は書かない (receipt も読まない)。ほかの注文は書く', async () => {
    const record = createOrderSaleRecorder();
    await record(
      [
        order(1, { txHash: '' }),
        { ...order(2), txHash: undefined } as unknown as StoredOrder,
        order(3, { amount: 'NaN' }),
        order(4),
      ],
      MERCHANT,
    );
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N4']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('72 時間ぶんがまとめて届いたとき: 件数ぶん 1 行ずつ・新しい注文が上・1 回の polling で読む receipt は上限まで', async () => {
    const total = ORDER_RECEIPT_READS_PER_PASS + 5;
    // 受注フィードは新しい順に届く。
    const orders = Array.from({ length: total }, (_, i) => order(total - i));
    const record = createOrderSaleRecorder();
    await record(orders, MERCHANT);
    expect(read).toHaveBeenCalledTimes(ORDER_RECEIPT_READS_PER_PASS);
    expect(loadHistory()).toHaveLength(ORDER_RECEIPT_READS_PER_PASS);
    await record(orders, MERCHANT);
    await record(orders, MERCHANT);
    expect(read).toHaveBeenCalledTimes(total);
    const rows = loadHistory();
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((e) => e.id)).size).toBe(total);
    // 履歴の並び = 新しい注文が上 (古い注文から書く)。
    expect(rows.map((e) => e.receiptNo)).toEqual(orders.map((o) => o.orderId));
    expect(rows.map((e) => e.ts)).toEqual([...rows.map((e) => e.ts)].sort((a, b) => b - a));
  });

  it('受取先が違うウォレットに切り替わったら、同じ書き手でも別の注文として扱う (前の受取先の決着を持ち越さない)', async () => {
    const record = createOrderSaleRecorder();
    // この受取先への入金が receipt に無い = 書かない (この受取先では決着)。
    await record([order(1)], OTHER_MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    await record([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0].merchant).toBe(MERCHANT);
  });
});

describe('createOrderSaleRecorder — receipt を読む回数の上限', () => {
  it('読めない注文は、上限の回数まで次の polling で読み直し、使い切ったら分かる欄だけの行を書く。その後は読まない', async () => {
    read.mockRejectedValue(new Error('rpc down'));
    const record = createOrderSaleRecorder();
    const orders = [order(1)];
    for (let i = 1; i < ORDER_RECEIPT_MAX_READS; i += 1) {
      await record(orders, MERCHANT);
      expect(read).toHaveBeenCalledTimes(i);
      expect(loadHistory()).toHaveLength(0);
    }
    await record(orders, MERCHANT);
    expect(read).toHaveBeenCalledTimes(ORDER_RECEIPT_MAX_READS);
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0]).toMatchObject({
      id: `batch-${tx(1)}`, merchantAmount: (990n * ONE).toString(), merchant: MERCHANT,
      customer: null, feeAmount: null, saleAmount: null, gasMode: null, receiptNo: 'N1',
    });
    for (let i = 0; i < 5; i += 1) await record(orders, MERCHANT);
    expect(read).toHaveBeenCalledTimes(ORDER_RECEIPT_MAX_READS);
    expect(loadHistory()).toHaveLength(1);
  });

  it('1 回目に読めず 2 回目に読めた注文は、全部の欄が入った行になる', async () => {
    read.mockRejectedValueOnce(new Error('rpc down'));
    const record = createOrderSaleRecorder();
    await record([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    await record([order(1)], MERCHANT);
    expect(loadHistory()[0]).toMatchObject({ customer: CUSTOMER, feeAmount: (10n * ONE).toString() });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('読めない注文があっても、同じ polling のほかの注文は書く', async () => {
    read.mockImplementation(async (_chainId: number, hash: Hex) => {
      if (hash === tx(1)) throw new Error('not found');
      return receipt();
    });
    const record = createOrderSaleRecorder();
    await record([order(3), order(2), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N3', 'N2']);
  });

  it('RPC が返らないとき: 待ち時間で切り上げ、後ろの注文と次の polling を止めない', async () => {
    vi.useFakeTimers();
    read.mockImplementation((_chainId: number, hash: Hex) =>
      hash === tx(1) ? new Promise(() => {}) : Promise.resolve(receipt()),
    );
    const record = createOrderSaleRecorder();
    const orders = [order(2), order(1)];
    const first = record(orders, MERCHANT);
    // 返らない読み取りを待っている間に来た次の polling は、重ねずに戻る。
    await record(orders, MERCHANT);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7_000);
    await first;
    // 後ろの注文 (2) は同じ回で書けている。返らなかった注文 (1) はまだ書かない。
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    for (let i = 1; i < ORDER_RECEIPT_MAX_READS; i += 1) {
      const pass = record(orders, MERCHANT);
      await vi.advanceTimersByTimeAsync(7_000);
      await pass;
    }
    // 上限を使い切って、分かる欄だけの行。
    expect(loadHistory().map((e) => [e.receiptNo, e.customer])).toEqual([['N1', null], ['N2', CUSTOMER]]);
    expect(read.mock.calls.filter(([, hash]) => hash === tx(1))).toHaveLength(ORDER_RECEIPT_MAX_READS);
  });

  it('1 回の polling で receipt の読み取りに使う時間を超えたら、残りは次の polling で読む', async () => {
    vi.useFakeTimers();
    read.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 6_000); // 遅い RPC: 1 回に 6 秒
      return receipt();
    });
    const record = createOrderSaleRecorder();
    const orders = [order(4), order(3), order(2), order(1)];
    await record(orders, MERCHANT);
    // 0 秒・6 秒の時点では読む。12 秒の時点で上限 (10 秒) を超えているので、3 件目からは次へ。
    expect(read).toHaveBeenCalledTimes(2);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2', 'N1']);
    await record(orders, MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N4', 'N3', 'N2', 'N1']);
  });

  it('この受取先への入金が receipt に無い注文は書かず、読み直しもしない', async () => {
    read.mockImplementation(async () => receipt(OTHER_MERCHANT));
    const record = createOrderSaleRecorder();
    for (let i = 0; i < 4; i += 1) await record([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('chain の表に無い注文は、receipt を読まずに外す', async () => {
    const record = createOrderSaleRecorder();
    await record([order(1, { chainId: 999_999 }), order(2)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('createOrderSaleRecorder — 失敗を呼び出し元へ出さない', () => {
  it('履歴の保存が throw しても reject しない。残りの注文も試し、警告は 1 回だけ。同じ画面では書き直さない', async () => {
    historyHold.failAppend = true;
    const record = createOrderSaleRecorder();
    const orders = [order(2), order(1)];
    await expect(record(orders, MERCHANT)).resolves.toBeUndefined();
    expect(historyHold.appends).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('orderFeedHistory.append_failed', expect.anything());
    historyHold.failAppend = false;
    await record(orders, MERCHANT);
    expect(historyHold.appends).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
    // 次に画面を開いたとき (新しい書き手) には書ける。
    await createOrderSaleRecorder()(orders, MERCHANT);
    expect(loadHistory()).toHaveLength(2);
  });

  it('受取先のアドレスが読めない・注文の一覧が配列でないときも reject しない (何も書かない)', async () => {
    const record = createOrderSaleRecorder();
    await expect(record([order(1)], 'not-an-address')).resolves.toBeUndefined();
    await expect(record(null as unknown as StoredOrder[], MERCHANT)).resolves.toBeUndefined();
    expect(loadHistory()).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    // 失敗の後も、同じ書き手で続けられる (実行中の印が残らない)。
    await record([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(1);
  });
});
