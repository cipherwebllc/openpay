// lib/orderFeedHistoryRecorder.ts: 受注フィードの注文を、receipt で確かめてから履歴に 1 件 1 行・1 回だけ書く。
// receipt の読み取り (lib/orderFeedReceipt.ts) だけを差し替え、履歴と「書いた」印 (localStorage) は実物。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Address, Hex } from 'viem';
import { recoverReceipt, transferLog } from '../_helpers/orderSaleReceipt';

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
  return { ...actual, env: { ...actual.env, enableMobileOrderFee: true, recoverFeeBps: 0 } };
});
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } }));
// 履歴は実物。読んだ回数・書いた回数を数え、保存の失敗 (throw・黙って入らない) と、保存の前後に割り込む操作 (別のタブの
// 全て削除など) を差し込めるようにだけする。
const historyHold = vi.hoisted(() => ({
  failAppend: false,
  dropAppend: false,
  loads: 0,
  appends: 0,
  beforeAppend: null as null | (() => void),
  afterAppend: null as null | (() => void),
}));
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
      // 割り込みは 1 回だけ (割り込みの中の appendHistory で、もう一度割り込まない)。
      const before = historyHold.beforeAppend;
      historyHold.beforeAppend = null;
      before?.();
      if (historyHold.failAppend) throw new Error('storage_broken');
      // appendHistory は localStorage の書き込みの失敗を投げない (safeSet)。その「黙って入らない」を再現する。
      if (historyHold.dropAppend) return;
      actual.appendHistory(entry);
      const after = historyHold.afterAppend;
      historyHold.afterAppend = null;
      after?.();
    },
  };
});

import { env } from '@/lib/env';
import { appendHistory, buildHistoryEntry, clearHistory, loadHistory, removeHistoryEntry } from '@/lib/history';
import {
  ORDER_RECEIPT_MAX_READS,
  ORDER_RECEIPT_READS_PER_PASS,
  ORDER_SALE_MARKS_KEY,
  ORDER_SALE_MARKS_MAX,
  createOrderSaleRecorder,
} from '@/lib/orderFeedHistoryRecorder';
import { buildOrderSaleEntry } from '@/lib/orderFeedHistory';
import { ORDER_LIST_MAX, type StoredOrder } from '@/lib/orderRelay';
import { deploymentForSlug } from '@/lib/tokens';

const FORWARDER: Address = '0x1111111111111111111111111111111111111111';
const MERCHANT: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER_MERCHANT: Address = '0x2222222222222222222222222222222222222222';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const JPYC = deploymentForSlug('jpyc', 'polygon');
const ONE = 10n ** 18n;
// 16 進の英字を含む hash (大文字にすると別の文字列になる = 大文字小文字の違いの確認が効く)。
const tx = (n: number) => `0x${'ab'.repeat(24)}${n.toString(16).padStart(16, '0')}` as Hex;

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

/** この tx の receipt (お客様 → forwarder → 受取先・利用料 10 = 1,000 の 1%)。 */
const receipt = (hash: string, merchant: Address = MERCHANT) =>
  recoverReceipt({
    token: JPYC.address, forwarder: FORWARDER, customer: CUSTOMER, merchant,
    merchantValue: 990n * ONE, feeReceiver: env.feeReceiver, feeValue: 10n * ONE, txHash: hash,
  });

/** 「書いた」印 (localStorage の生の値)。 */
function marks(): [string, number][] {
  const raw = window.localStorage.getItem(ORDER_SALE_MARKS_KEY);
  return raw === null ? [] : (JSON.parse(raw) as [string, number][]);
}
const markedHashes = () => marks().map(([hash]) => hash).sort();

/** 外から resolve する receipt (遅れて返る・2 つのタブが同時に待つ)。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async (_chainId: number, hash: string) => receipt(hash));
  historyHold.failAppend = false;
  historyHold.dropAppend = false;
  historyHold.loads = 0;
  historyHold.appends = 0;
  historyHold.beforeAppend = null;
  historyHold.afterAppend = null;
  warn.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createOrderSaleRecorder — 1 件 1 行・1 回だけ', () => {
  it('新しい注文で 1 行と「書いた」印。次の polling でも 1 行のまま (履歴も receipt も読み直さない)', async () => {
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
    expect(markedHashes()).toEqual([tx(1)]);
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

  it('エージェント注文は書かない (receipt も読まない・印も付けない)。ほかの注文は書く', async () => {
    const record = createOrderSaleRecorder();
    await record([order(2, { orderId: `agent-0x${'1'.repeat(16)}` }), order(1)], MERCHANT);
    await record([order(2, { orderId: `agent-0x${'1'.repeat(16)}` }), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N1']);
    expect(read.mock.calls.map(([, hash]) => hash)).toEqual([tx(1)]);
    expect(markedHashes()).toEqual([tx(1)]);
  });

  it('受注フィードの注文がまとめて届いたとき: 件数ぶん 1 行ずつ・新しい注文が上・1 回の polling で読む receipt は上限まで', async () => {
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

describe('createOrderSaleRecorder — receipt で確かめた注文だけを書く', () => {
  it('receipt を上限の回数まで読めない注文は書かない・印も付けない。次に画面を開いたら、もう一度読んで書く', async () => {
    read.mockRejectedValue(new Error('rpc down'));
    const record = createOrderSaleRecorder();
    const orders = [order(1)];
    for (let i = 1; i <= ORDER_RECEIPT_MAX_READS; i += 1) {
      await record(orders, MERCHANT);
      expect(read).toHaveBeenCalledTimes(i);
    }
    // 上限を使い切ったら、この画面では読まない。
    for (let i = 0; i < 5; i += 1) await record(orders, MERCHANT);
    expect(read).toHaveBeenCalledTimes(ORDER_RECEIPT_MAX_READS);
    expect(loadHistory()).toHaveLength(0);
    expect(historyHold.appends).toBe(0);
    expect(marks()).toEqual([]);
    // 次に受注の画面を開いたとき (新しい書き手)。
    read.mockReset();
    read.mockImplementation(async (_chainId: number, hash: string) => receipt(hash));
    await createOrderSaleRecorder()(orders, MERCHANT);
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0]).toMatchObject({ customer: CUSTOMER, feeAmount: (10n * ONE).toString() });
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

  it('RPC が別の tx の receipt を返したら書かない・印も付けない (この画面では読み直さない・次に開いたら読む)', async () => {
    read.mockImplementation(async () => receipt(tx(0x999)));
    const record = createOrderSaleRecorder();
    for (let i = 0; i < 3; i += 1) await record([order(1)], MERCHANT);
    expect(read).toHaveBeenCalledTimes(1);
    expect(loadHistory()).toHaveLength(0);
    expect(marks()).toEqual([]);
    read.mockImplementation(async (_chainId: number, hash: string) => receipt(hash));
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.txHash)).toEqual([tx(1)]);
  });

  it('この受取先への入金が receipt に無い注文 (別の店主の注文) は書かない・印も付けない', async () => {
    read.mockImplementation(async (_chainId: number, hash: string) => receipt(hash, OTHER_MERCHANT));
    const record = createOrderSaleRecorder();
    for (let i = 0; i < 4; i += 1) await record([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(marks()).toEqual([]);
  });

  describe('この受取先への入金の額が、着金額とちょうど同じ注文だけを書く (Transfer だけの receipt)', () => {
    const OTHER_PAYER: Address = '0x3333333333333333333333333333333333333333';
    /** 通常決済の注文 (着金額 990) の receipt に、指定の Transfer を並べる。 */
    const withTransfers = (...logs: ReturnType<typeof transferLog>[]) =>
      read.mockImplementation(async (_chainId: number, hash: string) => ({
        transactionHash: hash, status: 'success', blockNumber: 9n, logs,
      }));

    it('同じ receipt に、別の受取先への大きい入金 (990) と、この受取先への小さい入金 (1) がある: 書かない', async () => {
      withTransfers(
        transferLog(JPYC.address, CUSTOMER, OTHER_MERCHANT, 990n * ONE),
        transferLog(JPYC.address, OTHER_PAYER, MERCHANT, 1n * ONE),
      );
      await createOrderSaleRecorder()([order(1, { unboundPayment: true })], MERCHANT);
      expect(loadHistory()).toHaveLength(0);
      expect(marks()).toEqual([]);
    });

    it('この受取先への入金の合計が、着金額と 1 wei 違う: 書かない', async () => {
      withTransfers(
        transferLog(JPYC.address, CUSTOMER, MERCHANT, 500n * ONE),
        transferLog(JPYC.address, OTHER_PAYER, MERCHANT, 490n * ONE - 1n),
      );
      await createOrderSaleRecorder()([order(1, { unboundPayment: true })], MERCHANT);
      expect(loadHistory()).toHaveLength(0);
      withTransfers(transferLog(JPYC.address, CUSTOMER, MERCHANT, 990n * ONE + 1n));
      await createOrderSaleRecorder()([order(1, { unboundPayment: true })], MERCHANT);
      expect(loadHistory()).toHaveLength(0);
    });

    it('この受取先への入金の合計が、着金額とちょうど同じ (server と同じく送り主に関係なく合計): 1 行', async () => {
      withTransfers(
        transferLog(JPYC.address, CUSTOMER, MERCHANT, 500n * ONE),
        transferLog(JPYC.address, OTHER_PAYER, MERCHANT, 490n * ONE),
        transferLog(JPYC.address, CUSTOMER, OTHER_MERCHANT, 7n * ONE),
      );
      await createOrderSaleRecorder()([order(1, { unboundPayment: true })], MERCHANT);
      expect(loadHistory()).toHaveLength(1);
      // 受取先への Transfer が 2 本なので、お客様は決めない。
      expect(loadHistory()[0]).toMatchObject({ merchantAmount: (990n * ONE).toString(), customer: null, flow: 'standard-merchant' });
    });
  });

  it('revert した tx の注文は書かない・印も付けない', async () => {
    read.mockImplementation(async (_chainId: number, hash: string) => ({ ...receipt(hash), status: 'reverted' }));
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    expect(marks()).toEqual([]);
  });

  it('hash は合っているが log が壊れていて読み解きが throw する receipt: その注文はこの画面で上限の回数まで試して止め、後ろの注文は書く', async () => {
    read.mockImplementation(async (_chainId: number, hash: string) =>
      hash === tx(1)
        ? { transactionHash: hash, status: 'success', blockNumber: 1n, logs: [{ address: null, topics: [], data: '0x' }] }
        : receipt(hash),
    );
    const record = createOrderSaleRecorder();
    // 受注フィードの順 (新しい順) で 2 が先・1 が後。古い 1 から書くので、壊れた 1 の後ろに 2 がある。
    await record([order(2), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    for (let i = 0; i < ORDER_RECEIPT_MAX_READS + 3; i += 1) await record([order(2), order(1)], MERCHANT);
    expect(read.mock.calls.filter(([, hash]) => hash === tx(1))).toHaveLength(ORDER_RECEIPT_MAX_READS);
    expect(read.mock.calls.filter(([, hash]) => hash === tx(2))).toHaveLength(1);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(markedHashes()).toEqual([tx(2)]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('読めない注文があっても、同じ polling のほかの注文は書く', async () => {
    read.mockImplementation(async (_chainId: number, hash: Hex) => {
      if (hash === tx(1)) throw new Error('not found');
      return receipt(hash);
    });
    const record = createOrderSaleRecorder();
    await record([order(3), order(2), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N3', 'N2']);
    expect(markedHashes()).toEqual([tx(2), tx(3)]);
  });

  it('RPC が返らないとき: 待ち時間で切り上げ、後ろの注文と次の polling を止めない。上限まで返らなければ書かない', async () => {
    vi.useFakeTimers();
    read.mockImplementation((_chainId: number, hash: Hex) =>
      hash === tx(1) ? new Promise(() => {}) : Promise.resolve(receipt(hash)),
    );
    const record = createOrderSaleRecorder();
    const orders = [order(2), order(1)];
    const first = record(orders, MERCHANT);
    // 返らない読み取りを待っている間に来た次の polling は、重ねずに戻る。
    await record(orders, MERCHANT);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7_000);
    await first;
    // 後ろの注文 (2) は同じ回で書けている。返らなかった注文 (1) は書かない。
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    for (let i = 1; i < ORDER_RECEIPT_MAX_READS + 2; i += 1) {
      const pass = record(orders, MERCHANT);
      await vi.advanceTimersByTimeAsync(7_000);
      await pass;
    }
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(read.mock.calls.filter(([, hash]) => hash === tx(1))).toHaveLength(ORDER_RECEIPT_MAX_READS);
    expect(markedHashes()).toEqual([tx(2)]);
  });

  it('待ち時間の後に遅れて返った receipt は使わない (書かない)。次の polling で読み直して 1 行だけ書く', async () => {
    vi.useFakeTimers();
    const late = deferred<ReturnType<typeof receipt>>();
    read.mockImplementationOnce(() => late.promise);
    const record = createOrderSaleRecorder();
    const first = record([order(1)], MERCHANT);
    await vi.advanceTimersByTimeAsync(7_000);
    await first;
    expect(loadHistory()).toHaveLength(0);
    // 切り上げた後に返る。
    late.resolve(receipt(tx(1)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadHistory()).toHaveLength(0);
    expect(historyHold.appends).toBe(0);
    await record([order(1)], MERCHANT);
    expect(read).toHaveBeenCalledTimes(2);
    expect(loadHistory()).toHaveLength(1);
    expect(historyHold.appends).toBe(1);
  });

  it('1 回の polling で receipt の読み取りに使う時間を超えたら、残りは次の polling で読む', async () => {
    vi.useFakeTimers();
    read.mockImplementation(async (_chainId: number, hash: string) => {
      vi.setSystemTime(Date.now() + 6_000); // 遅い RPC: 1 回に 6 秒
      return receipt(hash);
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

  it('chain の表に無い注文は、receipt を読まずに外す', async () => {
    const record = createOrderSaleRecorder();
    await record([order(1, { chainId: 999_999 }), order(2)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('createOrderSaleRecorder — 消した行を書き戻さない (「書いた」印)', () => {
  it('書いた行を履歴から消しても、次に画面を開いたときに書き戻さない (receipt も読まない)', async () => {
    await createOrderSaleRecorder()([order(2), order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(2);
    removeHistoryEntry(`batch-${tx(1)}`);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    read.mockClear();
    await createOrderSaleRecorder()([order(2), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(read).not.toHaveBeenCalled();
  });

  it('全て削除しても、書き戻さない。印は消えない', async () => {
    await createOrderSaleRecorder()([order(2), order(1)], MERCHANT);
    clearHistory();
    expect(loadHistory()).toHaveLength(0);
    expect(markedHashes()).toEqual([tx(1), tx(2)]);
    await createOrderSaleRecorder()([order(3), order(2), order(1)], MERCHANT);
    // 新しく届いた注文だけが入る。
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N3']);
  });

  it('既に履歴にあった注文 (払った側が同じ端末で書いた行) にも印を付け、その行を消しても書かない', async () => {
    const payerRow = buildHistoryEntry({
      flow: 'batch', status: 'success', chainId: JPYC.chainId, chainSlug: 'polygon', asset: 'jpyc',
      tokenAddress: JPYC.address, payMode: 'gasless', gasMode: 'merchant', merchant: MERCHANT,
      merchantAmount: 990n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 10n * ONE,
      txHash: tx(1), userOpHash: null, blockNumber: null, errorMessage: null, storeName: '', note: '',
    });
    appendHistory(payerRow);
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(markedHashes()).toEqual([tx(1)]);
    clearHistory();
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('印は txHash (小文字) と時刻。履歴とは別の key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_763_500_000_000);
    const upper = order(0xabc, { txHash: `0x${tx(0xabc).slice(2).toUpperCase()}` });
    await createOrderSaleRecorder()([upper], MERCHANT);
    expect(loadHistory()).toHaveLength(1);
    expect(marks()).toEqual([[tx(0xabc), 1_763_500_000_000]]);
    expect(ORDER_SALE_MARKS_KEY).not.toBe('openpay:history:v1');
  });

  it('印は期限で捨てない (受注フィードに何日も残る注文を、何日後でも書き戻さない)', async () => {
    window.localStorage.setItem(ORDER_SALE_MARKS_KEY, JSON.stringify([[tx(1), Date.now() - 365 * 86_400_000]]));
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  });

  it(`印は ${ORDER_SALE_MARKS_MAX} 件まで (受注フィードの上限の 2 倍)。超えたら古い印から捨てる`, async () => {
    expect(ORDER_SALE_MARKS_MAX).toBe(ORDER_LIST_MAX * 2);
    const old = Array.from({ length: ORDER_SALE_MARKS_MAX }, (_, i) => [tx(0x10000 + i), 1_000 + i] as [string, number]);
    window.localStorage.setItem(ORDER_SALE_MARKS_KEY, JSON.stringify(old));
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    const kept = marks();
    expect(kept).toHaveLength(ORDER_SALE_MARKS_MAX);
    expect(kept.map(([hash]) => hash)).not.toContain(tx(0x10000));
    expect(kept.map(([hash]) => hash)).toContain(tx(0x10001));
    expect(kept[kept.length - 1][0]).toBe(tx(1));
  });

  it('限界: 印を書いた後に履歴の保存が黙って失敗した注文は、印を外さないので、この端末の履歴に入らない', async () => {
    historyHold.dropAppend = true;
    const record = createOrderSaleRecorder();
    await record([order(1)], MERCHANT);
    expect(historyHold.appends).toBe(1);
    expect(loadHistory()).toHaveLength(0);
    expect(markedHashes()).toEqual([tx(1)]);
    historyHold.dropAppend = false;
    await record([order(1)], MERCHANT);
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    expect(historyHold.appends).toBe(1);
  });

  it('印の値が壊れている (JSON でない・配列でない・形の違う要素がある) ときは、読めない印として書かない (空として作り直さない)', async () => {
    for (const broken of [
      '{not json',
      '"text"',
      JSON.stringify({ a: 1 }),
      JSON.stringify([[tx(5), 1], ['0x1234', 1]]),
      JSON.stringify([[tx(5), 1], [tx(6), 'x']]),
      JSON.stringify([[tx(5), 1], 5]),
    ]) {
      window.localStorage.clear();
      read.mockClear();
      window.localStorage.setItem(ORDER_SALE_MARKS_KEY, broken);
      await createOrderSaleRecorder()([order(1)], MERCHANT);
      expect(loadHistory()).toHaveLength(0);
      expect(read).not.toHaveBeenCalled();
      // 値はそのまま (作り直して、それまでの印を失わない)。
      expect(window.localStorage.getItem(ORDER_SALE_MARKS_KEY)).toBe(broken);
    }
  });

  it('印の key が無いのは、印が 0 件 (書く)', async () => {
    expect(window.localStorage.getItem(ORDER_SALE_MARKS_KEY)).toBeNull();
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(1);
  });

  /** 印の key だけ、読み取り・書き込みを壊す (ほかの key は実物)。 */
  function breakMarks(mode: { get?: boolean; set?: boolean }) {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (mode.get && key === ORDER_SALE_MARKS_KEY) throw new Error('SecurityError');
      return getItem.call(this, key);
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (mode.set && key === ORDER_SALE_MARKS_KEY) throw new Error('QuotaExceededError');
      setItem.call(this, key, value);
    });
    return {
      get,
      set,
      restore: () => {
        get.mockRestore();
        set.mockRestore();
      },
    };
  }

  it('印の読み取りが throw する: 書かない (receipt も履歴も読まない)。直ったら書く', async () => {
    const broken = breakMarks({ get: true });
    try {
      await expect(createOrderSaleRecorder()([order(1)], MERCHANT)).resolves.toBeUndefined();
      expect(broken.get).toHaveBeenCalledWith(ORDER_SALE_MARKS_KEY);
    } finally {
      broken.restore();
    }
    expect(historyHold.loads).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(loadHistory()).toHaveLength(0);
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(1);
  });

  it('印の書き込みが throw する: 行を書かない。この画面では上限の回数まで試し、直ったら次に開いた画面が書く', async () => {
    const broken = breakMarks({ set: true });
    const record = createOrderSaleRecorder();
    try {
      for (let i = 0; i < ORDER_RECEIPT_MAX_READS + 2; i += 1) await record([order(1)], MERCHANT);
      expect(broken.set).toHaveBeenCalledWith(ORDER_SALE_MARKS_KEY, expect.any(String));
    } finally {
      broken.restore();
    }
    expect(historyHold.appends).toBe(0);
    expect(loadHistory()).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(ORDER_RECEIPT_MAX_READS);
    expect(warn).not.toHaveBeenCalled();
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(1);
    expect(markedHashes()).toEqual([tx(1)]);
  });

  it('印の付いた注文は二度と書かない: 途中で印を書けなくなっても、書いた行には印があり、消しても戻らない', async () => {
    const record = createOrderSaleRecorder();
    await record([order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N1']);
    // ここから印を書けない。新しく届いた注文は書かない。
    const broken = breakMarks({ set: true });
    try {
      await record([order(2), order(1)], MERCHANT);
    } finally {
      broken.restore();
    }
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N1']);
    for (const row of loadHistory()) expect(markedHashes()).toContain(row.txHash!.toLowerCase());
    // 書いた行を消して開き直す: 戻らない。印を書けなかった注文は、ここで書く (印と一緒に)。
    clearHistory();
    await createOrderSaleRecorder()([order(2), order(1)], MERCHANT);
    expect(loadHistory().map((e) => e.receiptNo)).toEqual(['N2']);
    expect(markedHashes()).toEqual([tx(1), tx(2)]);
  });

  it('既に履歴にあった注文に印を付けられなかったときは、この画面では付け直さず、その行を消しても書き戻さない', async () => {
    appendHistory(
      buildHistoryEntry({
        flow: 'batch', status: 'success', chainId: JPYC.chainId, chainSlug: 'polygon', asset: 'jpyc',
        tokenAddress: JPYC.address, payMode: 'gasless', gasMode: 'merchant', merchant: MERCHANT,
        merchantAmount: 990n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 10n * ONE,
        txHash: tx(1), userOpHash: null, blockNumber: null, errorMessage: null, storeName: '', note: '払った側',
      }),
    );
    const record = createOrderSaleRecorder();
    const broken = breakMarks({ set: true });
    try {
      await record([order(1)], MERCHANT);
    } finally {
      broken.restore();
    }
    expect(marks()).toEqual([]);
    // 印を付けられなかった行を店主が消した。この画面の次の polling では書き戻さない (receipt も読まない)。
    clearHistory();
    for (let i = 0; i < 3; i += 1) await record([order(1)], MERCHANT);
    expect(read).not.toHaveBeenCalled();
    expect(loadHistory()).toHaveLength(0);
  });

  it('receipt を待っている間に払った側の行が入り、保存の直前の確認で見つけた注文に印を付けられなかったときも、この画面では決着にし、その行を消しても書き戻さない', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    read.mockImplementationOnce(() => pending.promise);
    const record = createOrderSaleRecorder();
    const pass = record([order(1)], MERCHANT);
    await Promise.resolve();
    // 待っている間に、同じ端末で払った側の行が入る。印の保存はここから失敗する。
    appendHistory(
      buildHistoryEntry({
        flow: 'batch', status: 'success', chainId: JPYC.chainId, chainSlug: 'polygon', asset: 'jpyc',
        tokenAddress: JPYC.address, payMode: 'gasless', gasMode: 'merchant', merchant: MERCHANT,
        merchantAmount: 990n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 10n * ONE,
        txHash: tx(1), userOpHash: null, blockNumber: null, errorMessage: null, storeName: '', note: '払った側',
      }),
    );
    historyHold.appends = 0;
    const broken = breakMarks({ set: true });
    try {
      pending.resolve(receipt(tx(1)));
      await pass;
      expect(broken.set).toHaveBeenCalledWith(ORDER_SALE_MARKS_KEY, expect.any(String));
    } finally {
      broken.restore();
    }
    expect(marks()).toEqual([]);
    expect(historyHold.appends).toBe(0);
    // 店主がその行を消し、保存領域が戻った。同じ画面の次の polling では書き戻さない (receipt も読み直さない)。
    clearHistory();
    for (let i = 0; i < 3; i += 1) await record([order(1)], MERCHANT);
    expect(read).toHaveBeenCalledTimes(1);
    expect(historyHold.appends).toBe(0);
    expect(loadHistory()).toHaveLength(0);
  });
});

describe('createOrderSaleRecorder — 書き手の途中に、別のタブの削除・払った側の保存が割り込む', () => {
  /** 印の key の書き込みの直前に割り込む (保存の直前の確認の後・印を書く前)。 */
  function beforeMarkWrite(interrupt: () => void) {
    const setItem = Storage.prototype.setItem;
    let done = false;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === ORDER_SALE_MARKS_KEY && !done) {
        done = true;
        interrupt();
      }
      setItem.call(this, key, value);
    });
  }
  const payerRow = (hash: string) =>
    buildHistoryEntry({
      flow: 'batch', status: 'success', chainId: JPYC.chainId, chainSlug: 'polygon', asset: 'jpyc',
      tokenAddress: JPYC.address, payMode: 'gasless', gasMode: 'merchant', merchant: MERCHANT,
      merchantAmount: 990n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 10n * ONE,
      txHash: hash, userOpHash: null, blockNumber: null, errorMessage: null, storeName: '', note: '払った側',
    });
  /** 書いた後の polling と、開き直した画面で、行が戻らないこと。 */
  async function expectNotRestored(record: ReturnType<typeof createOrderSaleRecorder>) {
    historyHold.beforeAppend = null;
    historyHold.afterAppend = null;
    await record([order(1)], MERCHANT);
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
  }

  it.each([
    ['全て削除', () => clearHistory()],
    ['1 行削除', () => removeHistoryEntry(`batch-${tx(1)}`)],
  ])('保存の後に%sが割り込む: 印は外さないので、消した行は戻らない', async (_label, remove) => {
    historyHold.afterAppend = remove;
    const record = createOrderSaleRecorder();
    await record([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(0);
    expect(markedHashes()).toEqual([tx(1)]);
    await expectNotRestored(record);
  });

  it.each([
    ['印を書いた後・保存の前', 'beforeAppend'],
    ['保存の直前の確認の後・印を書く前', 'beforeMark'],
  ] as const)('%sに全て削除が割り込む: まだ行は無いので 1 行書き、それを消しても戻らない', async (_label, at) => {
    const spy = at === 'beforeMark' ? beforeMarkWrite(() => clearHistory()) : null;
    if (at === 'beforeAppend') historyHold.beforeAppend = () => clearHistory();
    const record = createOrderSaleRecorder();
    try {
      await record([order(1)], MERCHANT);
    } finally {
      spy?.mockRestore();
    }
    expect(loadHistory()).toHaveLength(1);
    clearHistory();
    await expectNotRestored(record);
  });

  it.each([
    ['印を書いた後・保存の前', 'beforeAppend'],
    ['保存の直前の確認の後・印を書く前', 'beforeMark'],
    ['保存の後', 'afterAppend'],
  ] as const)('%sに、払った側が同じ id の行を書く: 1 行 (appendHistory が id で除く)', async (_label, at) => {
    const pay = () => appendHistory(payerRow(tx(1)));
    const spy = at === 'beforeMark' ? beforeMarkWrite(pay) : null;
    if (at === 'beforeAppend') historyHold.beforeAppend = pay;
    if (at === 'afterAppend') historyHold.afterAppend = pay;
    try {
      await createOrderSaleRecorder()([order(1)], MERCHANT);
    } finally {
      spy?.mockRestore();
    }
    expect(loadHistory()).toHaveLength(1);
    expect(markedHashes()).toEqual([tx(1)]);
  });
});

describe('createOrderSaleRecorder — 保存の直前にもう一度見る (2 つのタブ)', () => {
  it('2 つのタブが同じ注文の receipt を同時に待っても、1 行だけ', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    read.mockImplementation(() => pending.promise);
    const tabA = createOrderSaleRecorder()([order(1)], MERCHANT);
    const tabB = createOrderSaleRecorder()([order(1)], MERCHANT);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    pending.resolve(receipt(tx(1)));
    await Promise.all([tabA, tabB]);
    expect(loadHistory()).toHaveLength(1);
    expect(historyHold.appends).toBe(1);
    expect(markedHashes()).toEqual([tx(1)]);
  });

  it('同じ書き手の 2 つのタブは、同じ注文に同じ id の行を作る: 2 つとも保存の直前の確認を通っても 1 行 (appendHistory が id で除く)', () => {
    // 2 つのタブは同じ受注フィードの注文 (同じ txHash の文字列) から行を組む。
    const evidence = { kind: 'settled', customer: CUSTOMER, feeValue: 10n * ONE, blockNumber: 1n } as const;
    const tabA = buildOrderSaleEntry(order(1), MERCHANT, evidence)!;
    const tabB = buildOrderSaleEntry(order(1), MERCHANT, evidence)!;
    expect(tabB.id).toBe(tabA.id);
    appendHistory(tabA);
    appendHistory(tabB);
    expect(loadHistory()).toHaveLength(1);
  });

  it('receipt を待っている間に、別のタブが大文字の txHash で同じ注文を書いた: 2 行にしない (印は付ける)', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    read.mockImplementation(() => pending.promise);
    const tab = createOrderSaleRecorder()([order(1)], MERCHANT);
    await Promise.resolve();
    // 別のタブ (受注フィードの txHash が大文字) が先に書いた。
    appendHistory(
      buildHistoryEntry({
        flow: 'batch', status: 'success', chainId: JPYC.chainId, chainSlug: 'polygon', asset: 'jpyc',
        tokenAddress: JPYC.address, payMode: 'gasless', gasMode: 'merchant', merchant: MERCHANT,
        merchantAmount: 990n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 10n * ONE,
        txHash: `0x${tx(1).slice(2).toUpperCase()}`, userOpHash: null, blockNumber: null, errorMessage: null,
        storeName: '', note: '別のタブ',
      }),
    );
    historyHold.appends = 0;
    pending.resolve(receipt(tx(1)));
    await tab;
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0].note).toBe('別のタブ');
    expect(historyHold.appends).toBe(0);
    expect(markedHashes()).toEqual([tx(1)]);
  });

  it('receipt を待っている間に、別のタブが書いて店主が消した (印だけが残る): 書き戻さない', async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    read.mockImplementationOnce(() => pending.promise);
    const tab = createOrderSaleRecorder()([order(1)], MERCHANT);
    await Promise.resolve();
    await createOrderSaleRecorder()([order(1)], MERCHANT);
    expect(loadHistory()).toHaveLength(1);
    clearHistory();
    pending.resolve(receipt(tx(1)));
    await tab;
    expect(loadHistory()).toHaveLength(0);
  });
});

describe('createOrderSaleRecorder — 失敗を呼び出し元へ出さない', () => {
  it('履歴の保存が throw しても reject しない。残りの注文も試し、警告は 1 回だけ。印は外さない (その注文は入らない限界)', async () => {
    historyHold.failAppend = true;
    const record = createOrderSaleRecorder();
    const orders = [order(2), order(1)];
    await expect(record(orders, MERCHANT)).resolves.toBeUndefined();
    expect(historyHold.appends).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('orderFeedHistory.append_failed', expect.anything());
    expect(markedHashes()).toEqual([tx(1), tx(2)]);
    historyHold.failAppend = false;
    await record(orders, MERCHANT);
    await createOrderSaleRecorder()(orders, MERCHANT);
    expect(historyHold.appends).toBe(2);
    expect(loadHistory()).toHaveLength(0);
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
