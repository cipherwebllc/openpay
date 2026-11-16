// lib/qrSaleWatch.ts: QR を出している間と閉じた後 60 秒、forwarder の Settled を読み、bill key の nonce と一致した入金だけを
// 取引履歴に書く見張り。RPC の読み取り (lib/qrSaleRpc.ts) だけを差し替え、一致の判定・行の組み立て・履歴と印 (localStorage)
// は実物。時間は fake timer で進める。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';

const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn() }));
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
}));
const hold = vi.hoisted(() => ({
  forwarders: {} as Record<number, string>,
  failAppend: false,
  appends: 0,
  matches: 0,
  visibility: 'visible' as 'visible' | 'hidden',
}));
// 一致の判定は本物。何回判定したかだけ数える。
vi.mock('@/lib/qrSaleHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/qrSaleHistory')>();
  return {
    ...actual,
    matchSettledToBill: (...args: Parameters<typeof actual.matchSettledToBill>) => {
      hold.matches += 1;
      return actual.matchSettledToBill(...args);
    },
  };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => hold.forwarders[chainId] ?? null,
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } }));
// 履歴は実物。書いた回数を数え、保存の失敗 (throw) を差し込めるようにだけする。
vi.mock('@/lib/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/history')>();
  return {
    ...actual,
    appendHistory: (entry: Parameters<typeof actual.appendHistory>[0]) => {
      hold.appends += 1;
      if (hold.failAppend) throw new Error('storage_broken');
      actual.appendHistory(entry);
    },
  };
});

import { env } from '@/lib/env';
import {
  appendHistory,
  buildHistoryEntry,
  HISTORY_STORAGE_KEY,
  loadHistory,
  removeHistoryEntry,
} from '@/lib/history';
import { ORDER_SALE_MARKS_KEY } from '@/lib/orderFeedHistoryRecorder';
import { ORDER_FEED_MARKS_KEY, QR_SALE_MARKS_KEY, QR_SALE_MARKS_MAX } from '@/lib/qrSaleMarks';
import type { QrSaleLog } from '@/lib/qrSaleRpc';
import {
  QR_SALE_KEEP_AFTER_HIDE_MS,
  QR_SALE_MAX_BACK_BLOCKS,
  QR_SALE_OVERLAP_BLOCKS,
  QR_SALE_POLL_MS,
  hideQrBill,
  showQrBill,
  stopQrSaleWatch,
} from '@/lib/qrSaleWatch';
import { deploymentForSlug } from '@/lib/tokens';
import { buildCheckoutUrl, buildPayUrl, type PayParams } from '@/lib/url';
import { billNonce, saltNonce, settledRpcLog } from '../_helpers/qrSale';

const ORIGIN = 'https://shop.test';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER_SHOP: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BK = 'Zm9vYmFyYmF6cXV4MTIzNA';
const BK2 = 'a-b_c-d_e-f_g-h_0123Zz';
const BK3 = 'QQQQQQQQQQQQQQQQQQQQQQ';
const ONE = 10n ** 18n;
const POLYGON = deploymentForSlug('jpyc', 'polygon');
const KAIA = deploymentForSlug('jpyc', 'kaia');
const NOW = Date.UTC(2026, 10, 17, 3, 0, 0);
// block n の時刻 (unix 秒)。
const blockTime = (n: bigint) => 1_790_000_000n + n * 2n;
// 16 進の英字を含む hash (大文字にすると別の文字列になる)。
const tx = (n: number) => `0x${'ab'.repeat(24)}${n.toString(16).padStart(16, '0')}` as Hex;

// チェーンの代わり: 先頭の block と、取り込まれた Settled の log。
const chain = { head: 1_000n, logs: [] as QrSaleLog[] };

const payUrl = (over: Partial<PayParams> = {}) =>
  buildPayUrl(ORIGIN, { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', ...over });
const show = (billKey = BK, over: Partial<PayParams> = {}) =>
  showQrBill({ billKey, kind: 'pay', url: payUrl({ productName: 'ランチ', receiptNo: 'R-1', ...over }), itemName: 'お支払い' });

/** block に、この bill key の QR から署名した支払いの Settled を足す (既定 = 1,000 JPYC の会計どおりの金額)。 */
function settle(
  block: bigint,
  n: number,
  over: {
    billKey?: string; salt?: Hex; merchant?: Address; merchantValue?: bigint; feeValue?: bigint; logIndex?: number;
    chainId?: number; txHash?: string;
  } = {},
) {
  const sale = {
    from: CUSTOMER,
    merchant: over.merchant ?? SHOP,
    merchantValue: over.merchantValue ?? 998n * ONE,
    feeValue: over.feeValue ?? 2n * ONE,
    validBefore: blockTime(block) + 290n,
    chainId: over.chainId ?? POLYGON.chainId,
    forwarder: FORWARDER,
  };
  chain.logs.push(
    settledRpcLog({
      ...sale,
      nonce: over.salt ? saltNonce(over.salt, sale) : billNonce(over.billKey ?? BK, sale),
      txHash: over.txHash ?? tx(n),
      blockNumber: block,
      logIndex: over.logIndex ?? 0,
    }),
  );
}

const tick = (times = 1) => vi.advanceTimersByTimeAsync(QR_SALE_POLL_MS * times);
const marks = (key = QR_SALE_MARKS_KEY) =>
  (JSON.parse(window.localStorage.getItem(key) ?? '[]') as [string, number][]).map(([hash]) => hash);
const ranges = () => rpc.logs.mock.calls.map(([, , , from, to]) => [from, to]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  chain.head = 1_000n;
  chain.logs = [];
  hold.forwarders = { [POLYGON.chainId]: FORWARDER, [KAIA.chainId]: FORWARDER };
  hold.failAppend = false;
  hold.appends = 0;
  hold.matches = 0;
  hold.visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hold.visibility });
  rpc.head.mockReset().mockImplementation(async () => chain.head);
  rpc.logs
    .mockReset()
    .mockImplementation(async (_chainId: number, _forwarder: Address, _merchants: Address[], from: bigint, to: bigint) =>
      chain.logs.filter((log) => log.blockNumber! >= from && log.blockNumber! <= to),
    );
  rpc.time.mockReset().mockImplementation(async (_chainId: number, block: bigint) => blockTime(block));
  warn.mockReset();
});
afterEach(() => {
  stopQrSaleWatch();
  Reflect.deleteProperty(document, 'visibilityState');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('読む範囲と間隔', () => {
  it('QR を出すまでは RPC を読まない。出したら 6 秒おきに、先頭 → この受取先宛ての Settled の順に読む', async () => {
    await tick(3);
    expect(rpc.head).not.toHaveBeenCalled();
    show();
    expect(rpc.head).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QR_SALE_POLL_MS - 1);
    expect(rpc.head).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.head).toHaveBeenCalledTimes(1);
    expect(rpc.head).toHaveBeenCalledWith(POLYGON.chainId);
    // 初めての回: 「先頭 − 3 (Polygon)」までの 10 block。
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    expect(rpc.logs).toHaveBeenCalledWith(POLYGON.chainId, FORWARDER, [getAddress(SHOP)], 987n, 997n);
    // 一致する Settled が無ければ、block の時刻は読まない。
    expect(rpc.time).not.toHaveBeenCalled();
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(2);
  });

  it('見張らない QR (USDC・通常決済・金額なし・forwarder の無いチェーン・形の違う bill key) では、RPC を 1 回も読まない', async () => {
    const usdc = buildPayUrl(ORIGIN, { to: SHOP, token: 'usdc', chain: 'base', gas: 'customer', mode: 'gasless', amount: '5' });
    showQrBill({ billKey: BK, kind: 'pay', url: usdc, itemName: '' });
    showQrBill({ billKey: BK2, kind: 'pay', url: payUrl({ mode: 'standard' }), itemName: '' });
    showQrBill({ billKey: BK3, kind: 'pay', url: payUrl({ amount: undefined }), itemName: '' });
    showQrBill({ billKey: 'short', kind: 'pay', url: payUrl(), itemName: '' });
    hold.forwarders = {};
    showQrBill({ billKey: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'pay', url: payUrl(), itemName: '' });
    await tick(20);
    expect(rpc.head).not.toHaveBeenCalled();
    expect(rpc.logs).not.toHaveBeenCalled();
    expect(rpc.time).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('次の回は「前回の最後の block − 10」から。Polygon は先頭 − 3 まで・Kaia は先頭 − 1 まで', async () => {
    show();
    await tick();
    chain.head = 1_004n;
    await tick();
    chain.head = 1_004n;
    await tick();
    expect(ranges()).toEqual([[987n, 997n], [987n, 1_001n], [991n, 1_001n]]);
    expect(QR_SALE_OVERLAP_BLOCKS).toBe(10n);

    stopQrSaleWatch();
    rpc.logs.mockClear();
    show(BK2, { chain: 'kaia' });
    await tick();
    expect(rpc.logs).toHaveBeenCalledWith(KAIA.chainId, FORWARDER, [getAddress(SHOP)], 993n, 1_003n);
  });

  it('前回から間が空いたら、先頭 − 90 より前は読まない', async () => {
    show();
    await tick();
    chain.head = 1_500n;
    await tick();
    expect(ranges().at(-1)).toEqual([1_410n, 1_497n]);
    expect(QR_SALE_MAX_BACK_BLOCKS).toBe(90n);
    // 間が 90 block に収まるなら、前回の続き − 10 から。
    chain.head = 1_570n;
    await tick();
    expect(ranges().at(-1)).toEqual([1_487n, 1_567n]);
  });

  it('読む block が無ければ getLogs を呼ばない (先頭が戻った・チェーンの頭)。前回の位置は変えない', async () => {
    show();
    await tick();
    chain.head = 980n;
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    chain.head = 1_002n;
    await tick();
    // 前回 (997) の続きから。
    expect(ranges().at(-1)).toEqual([987n, 999n]);

    stopQrSaleWatch();
    rpc.logs.mockClear();
    chain.head = 2n;
    show(BK2);
    await tick();
    expect(rpc.logs).not.toHaveBeenCalled();
    chain.head = 5n;
    await tick();
    expect(ranges()).toEqual([[0n, 2n]]);
  });

  it('先頭を読めない回は飛ばす。まだ 1 回も読めていなければ、次に読めたとき先頭 − 90 から読む', async () => {
    rpc.head.mockRejectedValueOnce(new Error('rpc down'));
    show();
    await tick();
    expect(rpc.logs).not.toHaveBeenCalled();
    await tick();
    expect(ranges()).toEqual([[910n, 997n]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('getLogs を読めない回は飛ばし、次の回に同じ範囲の頭から読み直す (範囲の制限・rate limit・時間切れ)', async () => {
    show();
    await tick();
    chain.head = 1_010n;
    rpc.logs.mockRejectedValueOnce(new Error('query returned more than 10000 results'));
    await tick();
    chain.head = 1_012n;
    await tick();
    expect(ranges()).toEqual([[987n, 997n], [987n, 1_007n], [987n, 1_009n]]);
  });

  it('前の回がまだ RPC を待っている間は、次の回を重ねない', async () => {
    let release!: (head: bigint) => void;
    rpc.head.mockImplementationOnce(() => new Promise<bigint>((resolve) => { release = resolve; }));
    show();
    await tick();
    // 次の間隔 (12 秒) が来ても、前の回が待っているので読まない。
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(1);
    release(1_000n);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(2);
  });

  it('返らない RPC は 7 秒で切り、その後の回は読める (見張りが止まったままにならない)', async () => {
    rpc.head.mockImplementationOnce(() => new Promise<bigint>(() => {}));
    show();
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(1);
    // 6 秒後の回は、前の回が待っているので重ねない。7 秒で切れて、その次の回から読める。
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(1);
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(2);
    expect(rpc.logs).toHaveBeenCalledTimes(1);
  });

  it('タブが裏のあいだは読まない。戻ったら、前回の続きと先頭 − 90 の新しい方から読む', async () => {
    show();
    await tick();
    hold.visibility = 'hidden';
    chain.head = 1_020n;
    await tick(3);
    expect(rpc.head).toHaveBeenCalledTimes(1);
    hold.visibility = 'visible';
    await tick();
    expect(ranges().at(-1)).toEqual([987n, 1_017n]);

    // 出してすぐ裏にして、1 回も読めていない → 戻ったら先頭 − 90 から。
    stopQrSaleWatch();
    rpc.logs.mockClear();
    hold.visibility = 'hidden';
    show(BK2);
    await tick(2);
    hold.visibility = 'visible';
    await tick();
    expect(ranges()).toEqual([[930n, 1_017n]]);
  });

  it('2 つのチェーン・2 つの受取先の QR: チェーンごとに 1 回ずつ、そのチェーンの受取先をまとめて読む', async () => {
    show(BK);
    show(BK2, { to: OTHER_SHOP });
    show(BK3, { chain: 'kaia' });
    await tick();
    expect(rpc.head.mock.calls.map(([chainId]) => chainId)).toEqual([POLYGON.chainId, KAIA.chainId]);
    expect(rpc.logs.mock.calls.map(([chainId, , merchants]) => [chainId, merchants])).toEqual([
      [POLYGON.chainId, [getAddress(SHOP), getAddress(OTHER_SHOP)]],
      [KAIA.chainId, [getAddress(SHOP)]],
    ]);
  });
});

describe('一致した入金だけを行にする', () => {
  it('その会計の 1 件目で、金額も期待値と同じ → 会計の写しの明細・管理番号つきの行 (時刻は block の時刻)', async () => {
    show();
    settle(995n, 1);
    await tick();
    expect(rpc.time).toHaveBeenCalledWith(POLYGON.chainId, 995n);
    const rows = loadHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `batch-${tx(1)}`,
      ts: Number(blockTime(995n)) * 1000,
      flow: 'batch',
      status: 'success',
      payMode: 'gasless',
      gasMode: 'merchant',
      merchant: getAddress(SHOP),
      customer: getAddress(CUSTOMER),
      merchantAmount: (998n * ONE).toString(),
      feeAmount: '0',
      networkFeeEquivalent: (2n * ONE).toString(),
      saleAmount: (1_000n * ONE).toString(),
      feeReceiver: env.feeReceiver,
      blockNumber: null,
      txHash: tx(1),
      productName: 'ランチ',
      receiptNo: 'R-1',
    });
    expect(rows[0].lineItems).toHaveLength(1);
    expect(marks()).toEqual([tx(1)]);
  });

  it('一致しない Settled (乱数の salt・別の bill key・別の受取先宛て) は、行にも印にもしない', async () => {
    show();
    settle(990n, 1, { salt: `0x${'a1'.repeat(32)}` });
    settle(991n, 2, { billKey: BK2 });
    settle(992n, 3, { merchant: OTHER_SHOP });
    await tick();
    expect(rpc.time).toHaveBeenCalledTimes(3);
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
    expect(hold.appends).toBe(0);
    // 生きている会計は 1 つ。Settled 1 つにつき 1 回ずつ判定した。
    expect(hold.matches).toBe(3);
    // 重ねて読んだ分は、もう一度確かめない (block の時刻も読まず、判定もし直さない)。
    await tick();
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(3);
    expect(rpc.time).toHaveBeenCalledTimes(3);
    expect(hold.matches).toBe(3);
  });

  it('同じ会計への 2 件目の入金 (同じ QR の 2 回目の支払い) は、明細なしの行', async () => {
    show();
    settle(994n, 1);
    settle(995n, 2);
    await tick();
    const [second, first] = loadHistory();
    expect(first).toMatchObject({ id: `batch-${tx(1)}`, productName: 'ランチ', receiptNo: 'R-1' });
    expect(first.lineItems).toHaveLength(1);
    expect(second).toMatchObject({
      id: `batch-${tx(2)}`, productName: null, receiptNo: null, lineItems: null, storeName: '',
      merchantAmount: (998n * ONE).toString(), customer: getAddress(CUSTOMER),
    });
    // 次の回に届いた 3 件目も明細なし。
    chain.head = 1_004n;
    settle(1_000n, 3);
    await tick();
    expect(loadHistory()[0]).toMatchObject({ id: `batch-${tx(3)}`, lineItems: null, receiptNo: null });
  });

  it('同じ block の中では、log の番号の小さい方が 1 件目', async () => {
    show();
    settle(995n, 2, { logIndex: 7 });
    settle(995n, 1, { logIndex: 3 });
    await tick();
    const byId = Object.fromEntries(loadHistory().map((e) => [e.id, e]));
    expect(byId[`batch-${tx(1)}`].receiptNo).toBe('R-1');
    expect(byId[`batch-${tx(2)}`].receiptNo).toBeNull();
  });

  it('bill key は合うが金額が会計と違う入金は、明細なしの行 (金額は log の値)。その後の入金も 2 件目として明細なし', async () => {
    show();
    settle(994n, 1, { merchantValue: 498n * ONE, feeValue: 2n * ONE });
    settle(995n, 2);
    await tick();
    const [second, first] = loadHistory();
    expect(first).toMatchObject({
      id: `batch-${tx(1)}`, merchantAmount: (498n * ONE).toString(), saleAmount: (500n * ONE).toString(),
      networkFeeEquivalent: (2n * ONE).toString(), lineItems: null, receiptNo: null, productName: null,
    });
    expect(second).toMatchObject({ id: `batch-${tx(2)}`, lineItems: null, receiptNo: null });
  });

  it('金額が同じなだけ (bill key が違う) の入金は、行にしない', async () => {
    show();
    settle(995n, 1, { salt: `0x${'b2'.repeat(32)}` });
    await tick();
    expect(loadHistory()).toEqual([]);
  });

  it('重ねて読んだ同じ log は 1 回だけ処理する (1 行・block の時刻も読み直さない)', async () => {
    show();
    settle(995n, 1);
    await tick();
    await tick();
    chain.head = 1_002n;
    await tick();
    expect(loadHistory()).toHaveLength(1);
    expect(hold.appends).toBe(1);
    expect(rpc.time).toHaveBeenCalledTimes(1);
  });

  it('レジの QR (/checkout) の会計: 明細・商品名の連結・管理番号つきの行', async () => {
    const url = buildCheckoutUrl(ORIGIN, {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', receiptNo: 'R-0012',
      items: [{ name: 'コーヒー', qty: 2, price: '500' }, { name: 'ケーキ', qty: 1, price: '480' }],
    });
    showQrBill({ billKey: BK, kind: 'checkout', url, itemName: '' });
    settle(995n, 1, { merchantValue: 1_478n * ONE });
    await tick();
    expect(loadHistory()[0]).toMatchObject({
      id: `batch-${tx(1)}`, productName: 'コーヒー, ケーキ', receiptNo: 'R-0012', saleAmount: (1_480n * ONE).toString(),
    });
    expect(loadHistory()[0].lineItems).toHaveLength(2);
  });

  it('同じ tx に一致が 2 つ以上あるときは、どれも書かない (履歴の行は tx ごとに 1 つ)', async () => {
    show(BK);
    show(BK2, { amount: '300' });
    settle(995n, 1, { logIndex: 0 });
    settle(995n, 1, { logIndex: 1, billKey: BK2, merchantValue: 298n * ONE });
    settle(996n, 2);
    await tick();
    // 別の tx の入金は書く (その会計の 2 件目なので明細なし)。
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(2)}`]);
    expect(loadHistory()[0].lineItems).toBeNull();
    expect(marks()).toEqual([tx(2)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('qrSale.multiple_matches_in_tx', {});
  });

  it('番号の無い log (取り込み前) と、forwarder の Settled として読めない log は無視する', async () => {
    show();
    settle(995n, 1);
    chain.logs.push({ ...chain.logs[0], transactionHash: null });
    chain.logs.push({ ...chain.logs[0], logIndex: null });
    chain.logs.push({ ...chain.logs[0], blockNumber: null as unknown as bigint });
    chain.logs.push({ ...chain.logs[0], transactionHash: tx(9), logIndex: 4, data: '0x' });
    rpc.logs.mockImplementation(async () => chain.logs);
    await tick();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(1)}`]);
    expect(rpc.time).toHaveBeenCalledTimes(1);
  });

  it('block の時刻を読めない log は「読んだ」ことにせず、次の回に読み直す。先に一致した分は書く', async () => {
    show();
    settle(994n, 1);
    settle(995n, 2);
    rpc.time.mockImplementation(async (_chainId: number, block: bigint) => {
      if (block === 995n) throw new Error('rpc down');
      return blockTime(block);
    });
    await tick();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(1)}`]);
    rpc.time.mockImplementation(async (_chainId: number, block: bigint) => blockTime(block));
    chain.head = 1_002n;
    await tick();
    // 読めた範囲として進めていない (まだ 1 回も読み終えていないので、先頭 − 90 から読み直す)。
    expect(ranges()).toEqual([[987n, 997n], [912n, 999n]]);
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(2)}`, `batch-${tx(1)}`]);
    // 2 件目として明細なし。
    expect(loadHistory()[0].lineItems).toBeNull();
  });

  it('block の時刻が読めない値 (0・数でない) の log は、行にしない', async () => {
    show();
    settle(995n, 1);
    rpc.time.mockResolvedValue(0n);
    await tick();
    expect(loadHistory()).toEqual([]);
    rpc.time.mockResolvedValue('1790000000' as unknown as bigint);
    await tick();
    expect(loadHistory()).toEqual([]);
  });
});

describe('保存の決まり (同じ tx は 1 行・印が先・印は外さない)', () => {
  const payerRow = (hash: string) =>
    buildHistoryEntry({
      flow: 'batch', status: 'success', chainId: POLYGON.chainId, chainSlug: 'polygon', asset: 'jpyc',
      tokenAddress: POLYGON.address, payMode: 'gasless', gasMode: 'merchant', merchant: SHOP,
      merchantAmount: 998n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 0n,
      txHash: hash, userOpHash: null, blockNumber: null, errorMessage: null, storeName: 'payer wrote this',
    });

  it('同じ tx の行が履歴にあれば書かない (大文字小文字が違っても・flow が違っても)。その tx に印は付ける', async () => {
    appendHistory(payerRow(tx(1).toUpperCase().replace('0X', '0x')));
    appendHistory({ ...payerRow(tx(2)), id: `standard-merchant-${tx(2)}`, flow: 'standard-merchant' });
    hold.appends = 0;
    show();
    settle(994n, 1);
    settle(995n, 2);
    await tick();
    expect(hold.appends).toBe(0);
    expect(loadHistory()).toHaveLength(2);
    expect(loadHistory().every((e) => e.storeName === 'payer wrote this')).toBe(true);
    expect(marks().sort()).toEqual([tx(1), tx(2)]);
  });

  it('自分の印がある tx は書かない', async () => {
    window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify([[tx(1), 1]]));
    show();
    settle(995n, 1);
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(hold.appends).toBe(0);
  });

  it('受注の書き手 (モバイルオーダー) の印がある tx は書かない (向こうが書いて店主が消した行を、書き戻さない)', async () => {
    expect(ORDER_FEED_MARKS_KEY).toBe(ORDER_SALE_MARKS_KEY);
    window.localStorage.setItem(ORDER_SALE_MARKS_KEY, JSON.stringify([[tx(1), 1]]));
    show();
    settle(995n, 1);
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(hold.appends).toBe(0);
    // 向こうの key には書かない・自分の印も付けない。
    expect(marks(ORDER_SALE_MARKS_KEY)).toEqual([tx(1)]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
  });

  it('書いた行を店主が消しても、書き戻さない (重ねて読んだとき・log の番号が変わって読み直したとき・全て削除の後)', async () => {
    show();
    settle(995n, 1);
    await tick();
    expect(loadHistory()).toHaveLength(1);
    removeHistoryEntry(`batch-${tx(1)}`);
    await tick();
    expect(loadHistory()).toEqual([]);
    // 組み直し (reorg) で同じ tx が別の log の番号で届いた = 「読んだ log」には無い。印で止まる。
    chain.logs[0] = { ...chain.logs[0], logIndex: 5 };
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(hold.appends).toBe(1);
    expect(marks()).toEqual([tx(1)]);
  });

  it.each([
    ['自分の印が JSON として読めない', QR_SALE_MARKS_KEY, '{broken'],
    ['自分の印が配列でない', QR_SALE_MARKS_KEY, '{"a":1}'],
    ['自分の印に形の違う要素がある', QR_SALE_MARKS_KEY, JSON.stringify([[tx(7), 1], ['not-a-hash', 2]])],
    ['受注の書き手の印が読めない', ORDER_SALE_MARKS_KEY, 'null!'],
    ['受注の書き手の印に形の違う要素がある', ORDER_SALE_MARKS_KEY, JSON.stringify([[tx(7), 'x']])],
  ])('%s → 書かない (印を作り直さない)', async (_name, key, value) => {
    window.localStorage.setItem(key, value);
    show();
    settle(995n, 1);
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(hold.appends).toBe(0);
    expect(window.localStorage.getItem(key)).toBe(value);
    // 読めない印は「書かない」と決めた場面で、失敗ではない (警告を残さない)。
    expect(warn).not.toHaveBeenCalled();
  });

  it('localStorage を読めない (getItem が throw) → 書かない・画面へ throw しない', async () => {
    show();
    settle(995n, 1);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    await tick();
    getItem.mockRestore();
    expect(hold.appends).toBe(0);
    expect(loadHistory()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('印を書けない (setItem が throw) → 行を書かない', async () => {
    show();
    settle(995n, 1);
    const real = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === QR_SALE_MARKS_KEY) throw new Error('QuotaExceededError');
      real.call(this, key, value);
    });
    await tick();
    setItem.mockRestore();
    expect(hold.appends).toBe(0);
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
  });

  it('印を先に書いてから行を書く (保存の順)', async () => {
    show();
    settle(995n, 1);
    const real = Storage.prototype.setItem;
    const order: string[] = [];
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      order.push(key);
      real.call(this, key, value);
    });
    await tick();
    setItem.mockRestore();
    expect(order.indexOf(QR_SALE_MARKS_KEY)).toBe(0);
    expect(order.indexOf(HISTORY_STORAGE_KEY)).toBeGreaterThan(0);
  });

  it('履歴の保存が throw しても、印は残し (外さない)、後ろの入金の記録を続ける。警告は 1 回', async () => {
    show();
    settle(994n, 1);
    hold.failAppend = true;
    await tick();
    expect(marks()).toEqual([tx(1)]);
    expect(loadHistory()).toEqual([]);
    hold.failAppend = false;
    chain.head = 1_002n;
    settle(999n, 2);
    await tick();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(2)}`]);
    // 印の付いた 1 件目は、二度と書かない。
    expect(marks().sort()).toEqual([tx(1), tx(2)]);
    expect(hold.appends).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('qrSale.save_failed');
  });

  it('印は上限 (履歴の行の上限と同じ 1,000 件) まで持ち、古いものから捨てる', async () => {
    expect(QR_SALE_MARKS_MAX).toBe(1_000);
    const old = Array.from({ length: QR_SALE_MARKS_MAX }, (_, i) => [tx(10_000 + i), i + 1]);
    window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify(old));
    show();
    settle(995n, 1);
    await tick();
    const kept = marks();
    expect(kept).toHaveLength(QR_SALE_MARKS_MAX);
    expect(kept).toContain(tx(1));
    expect(kept).not.toContain(tx(10_000));
    expect(kept).toContain(tx(10_001));
  });

  it('bill key と会計の写しは、localStorage / sessionStorage のどこにも残らない (履歴の行と tx の印だけ)', async () => {
    show();
    settle(995n, 1);
    await tick();
    hideQrBill(BK);
    await tick();
    const dump = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, i) => `${storage.key(i)}=${storage.getItem(storage.key(i)!)}`).join('\n');
    expect(Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).sort()).toEqual(
      [HISTORY_STORAGE_KEY, QR_SALE_MARKS_KEY].sort(),
    );
    expect(dump(window.localStorage)).not.toContain(BK);
    expect(dump(window.localStorage)).not.toContain('bk=');
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('表示をやめた後・止めた後', () => {
  it('QR を閉じた後 60 秒は読み続け、その間の入金を行にする。60 秒を過ぎたら読むのをやめる', async () => {
    show();
    await tick();
    hideQrBill(BK);
    chain.head = 1_020n;
    settle(1_010n, 1);
    await tick(5);
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(1)}`]);
    expect(loadHistory()[0].receiptNo).toBe('R-1');
    // 閉じてから 60 秒ちょうどの回までは読む。
    await tick(5);
    const callsAt60 = rpc.head.mock.calls.length;
    expect(callsAt60).toBe(11);
    expect(QR_SALE_KEEP_AFTER_HIDE_MS).toBe(60_000);
    chain.head = 1_100n;
    settle(1_090n, 2);
    await tick(10);
    expect(rpc.head).toHaveBeenCalledTimes(callsAt60);
    expect(loadHistory()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('出し直した QR: 前の bill key も 60 秒は生きていて、その会計の明細で行になる。過ぎたら前の会計の入金は行にしない', async () => {
    show(BK, { receiptNo: 'OLD' });
    await tick();
    hideQrBill(BK);
    show(BK2, { receiptNo: 'NEW', amount: '700' });
    chain.head = 1_010n;
    settle(1_004n, 1);
    settle(1_005n, 2, { billKey: BK2, merchantValue: 698n * ONE });
    await tick();
    const byId = Object.fromEntries(loadHistory().map((e) => [e.id, e]));
    expect(byId[`batch-${tx(1)}`].receiptNo).toBe('OLD');
    expect(byId[`batch-${tx(2)}`].receiptNo).toBe('NEW');
    await tick(11);
    chain.head += 30n;
    settle(chain.head - 5n, 3);
    settle(chain.head - 5n, 4, { billKey: BK2, merchantValue: 698n * ONE, logIndex: 1 });
    await tick();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(4)}`, `batch-${tx(2)}`, `batch-${tx(1)}`]);
  });

  it('同じ bill key を出し直す (StrictMode の effect の二重: 出す → やめる → 出す) と表示中に戻り、見張りは 1 つのまま', async () => {
    show();
    hideQrBill(BK);
    show();
    expect(vi.getTimerCount()).toBe(1);
    await tick(15);
    // 60 秒を過ぎても読み続けている (表示中)。1 回の間隔に先頭を読むのは 1 回。
    expect(rpc.head).toHaveBeenCalledTimes(15);
    chain.head = 1_100n;
    settle(1_090n, 1);
    await tick();
    expect(loadHistory()[0]).toMatchObject({ id: `batch-${tx(1)}`, receiptNo: 'R-1' });
  });

  it('出していない bill key の hide は何もしない', () => {
    expect(() => hideQrBill(BK)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('/create を離れたら (stop) すぐ止める。RPC を待っている回が後から返っても、行を書かない', async () => {
    let release!: (logs: QrSaleLog[]) => void;
    show();
    settle(995n, 1);
    rpc.logs.mockImplementationOnce(() => new Promise<QrSaleLog[]>((resolve) => { release = resolve; }));
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    stopQrSaleWatch();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    release(chain.logs);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.time).not.toHaveBeenCalled();
    expect(loadHistory()).toEqual([]);
    await tick(5);
    expect(rpc.head).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('block の時刻を待っている間に止められた回も、行を書かない', async () => {
    let release!: (time: bigint) => void;
    show();
    settle(995n, 1);
    rpc.time.mockImplementationOnce(() => new Promise<bigint>((resolve) => { release = resolve; }));
    await tick();
    stopQrSaleWatch();
    release(blockTime(995n));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
  });

  it('止めた後にまた QR を出すと、新しい見張りとして始まる (前の bill key・読んだ範囲は持ち越さない)', async () => {
    show();
    await tick();
    stopQrSaleWatch();
    rpc.logs.mockClear();
    chain.head = 5_000n;
    show(BK2, { receiptNo: 'NEXT' });
    settle(4_995n, 1);
    settle(4_996n, 2, { billKey: BK2 });
    await tick();
    expect(ranges()).toEqual([[4_987n, 4_997n]]);
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([[`batch-${tx(2)}`, 'NEXT']]);
  });

  it('外に出す関数は throw しない (会計の写しを読めない・RPC が壊れた値を返す)', async () => {
    expect(() => showQrBill({ billKey: BK, kind: 'pay', url: 'not a url', itemName: '' })).not.toThrow();
    expect(() => showQrBill({ billKey: BK, kind: 'checkout', url: `${ORIGIN}/checkout?items=%%%`, itemName: '' })).not.toThrow();
    show(BK2);
    rpc.head.mockResolvedValue('1000' as unknown as bigint);
    await tick();
    expect(rpc.logs).not.toHaveBeenCalled();
    rpc.head.mockResolvedValue(1_000n);
    rpc.logs.mockResolvedValue(null as unknown as QrSaleLog[]);
    await tick();
    expect(loadHistory()).toEqual([]);
  });
});
