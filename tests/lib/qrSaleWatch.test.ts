// lib/qrSaleWatch.ts: QR を出している間と閉じた後 60 秒、forwarder の Settled を読み、bill key の nonce と一致した入金だけを
// 取引履歴に書く見張り。RPC の読み取り (lib/qrSaleRpc.ts) と nonce の式 (軽い差し替え・下) を差し替え、一致の判定・行の組み立て・
// 履歴と印 (localStorage) は実物。時間は fake timer で進める。
// nonce の本物の式 (keccak) と一致の判定が合うことは tests/lib/qrSaleHistory.test.ts と
// tests/components/qrSaleHistory.parity.test.tsx が確かめる。ここは見張りの回し方 (範囲・順・上限・時刻の窓・保存) を見る。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAddress, HttpRequestError, type Address, type Hex } from 'viem';

const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn(), transfers: vi.fn() }));
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
  // ガスレスの会計は JPYC の Transfer も読む (払う側で通常決済に切り替えた入金 = readSwitchedTransferLogs)。この file の既定は
  // 「読めて、1 つも無い」(正常な保存の経路)。切り替えた入金・失敗・遅れは tests/lib/qrSaleWatch.switched.test.ts が個別に入れる。
  readTransferLogs: rpc.transfers,
  readSwitchedTransferLogs: rpc.transfers,
}));
const hold = vi.hoisted(() => ({
  forwarders: {} as Record<number, string>,
  failAppend: false,
  // この数だけ、次の appendHistory を失敗させる (throw)。
  failNext: 0,
  appends: 0,
  matches: 0,
  nonces: 0,
  visibility: 'visible' as 'visible' | 'hidden',
}));
// nonce の式は軽い差し替え (tests/_helpers/fakeForwarderNonce.ts: 入力の組ごとに決まった値・一致の判定にとっては本物の
// hash と同じ)。本物の keccak を 1,230 回 × 組の数だけ計算すると、coverage つきの CI で遅い。何回計算したかを数える。
// 払う側の nonce (テストの道具 billNonce) も同じ差し替えで作る。
vi.mock('@/lib/relay/forwarderIntent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderIntent')>();
  const { createFakeForwarderNonce } = await import('@/tests/_helpers/fakeForwarderNonce');
  const fake = createFakeForwarderNonce();
  return {
    ...actual,
    buildForwarderNonce: (...args: Parameters<typeof actual.buildForwarderNonce>) => {
      hold.nonces += 1;
      return fake(...args);
    },
  };
});
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
      if (hold.failAppend) throw new Error(`storage_broken ${entry.txHash}`);
      if (hold.failNext > 0) {
        hold.failNext -= 1;
        throw new Error('storage_broken');
      }
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
  TODAY_SUMMARY_KEY,
} from '@/lib/history';
import { ORDER_SALE_MARKS_KEY } from '@/lib/orderFeedHistoryRecorder';
import { ORDER_FEED_MARKS_KEY, QR_SALE_MARKS_KEY, QR_SALE_MARKS_MAX } from '@/lib/qrSaleMarks';
import type { QrSaleLog } from '@/lib/qrSaleRpc';
import {
  QR_SALE_CLOCK_SKEW_MS,
  QR_SALE_KEEP_AFTER_HIDE_MS,
  QR_SALE_MAX_BACK_BLOCKS,
  QR_SALE_MAX_GETLOGS_PER_PASS,
  QR_SALE_MAX_PAIRS_PER_PASS,
  QR_SALE_SMALL_RANGE_BLOCKS,
  QR_SALE_OVERLAP_BLOCKS,
  QR_SALE_POLL_MS,
  hideQrBill,
  isBlockRangeLimitError,
  showQrBill,
  stopQrSaleWatch,
  type QrBillRecorded,
} from '@/lib/qrSaleWatch';
import { deploymentForSlug } from '@/lib/tokens';
import { buildCheckoutUrl, buildPayUrl, type PayParams } from '@/lib/url';
import { billNonce, saltNonce, settledRpcLog } from '../_helpers/qrSale';

const ORIGIN = 'https://shop.test';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER_SHOP: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BK = 'Zm9vYmFyYmE';
const BK2 = 'a-b_c-d_e-8';
const BK3 = 'QQQQQQQQQQQ';
const ONE = 10n ** 18n;
const POLYGON = deploymentForSlug('jpyc', 'polygon');
const KAIA = deploymentForSlug('jpyc', 'kaia');
const NOW = Date.UTC(2026, 10, 17, 3, 0, 0);
// block n の時刻 (unix 秒)。block 1,000 = NOW (テストの始めの端末の時刻)・1 block 2 秒。
const blockTime = (n: bigint) => BigInt(NOW / 1000) + (n - 1_000n) * 2n;
// 見張りの回 1 つで、+290 秒の有効期限の nonce に一致するまでの計算の回数 (+300 → +299 → +301 → … → +290 は 20 回目)。
const NONCES_TO_MATCH = 20;
// 一致しない (log, 会計) の組 1 つの計算の回数 (+1 … +1,230 の全部)。
const NONCES_PER_MISS = 1_230;
// 乱数の intentSalt (bill key を使わない支払い)。
const random = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}` as Hex;
// 16 進の英字を含む hash (大文字にすると別の文字列になる)。
const tx = (n: number) => `0x${'ab'.repeat(24)}${n.toString(16).padStart(16, '0')}` as Hex;

// チェーンの代わり: 先頭の block と、取り込まれた Settled の log。
const chain = { head: 1_000n, logs: [] as QrSaleLog[] };

const payUrl = (over: Partial<PayParams> = {}) =>
  buildPayUrl(ORIGIN, { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', ...over });
const show = (billKey = BK, over: Partial<PayParams> = {}, shownAt = Date.now()) =>
  showQrBill(
    { billKey, kind: 'pay', url: payUrl({ productName: 'ランチ', receiptNo: 'R-1', ...over }), itemName: 'お支払い' },
    shownAt,
  );
const hide = (billKey = BK, hiddenAt = Date.now()) => hideQrBill(billKey, hiddenAt);

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

/** チェーンの log のうち、範囲 (両端を含む) と受取先の topic に当たるもの (本物の getLogs の絞り込み)。 */
const logsIn = (merchants: readonly Address[], from: bigint, to: bigint) =>
  chain.logs.filter(
    (log) =>
      log.blockNumber! >= from && log.blockNumber! <= to &&
      merchants.some((m) => getAddress(`0x${log.topics[3]!.slice(26)}`) === getAddress(m)),
  );
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
  hold.failNext = 0;
  hold.appends = 0;
  hold.matches = 0;
  hold.nonces = 0;
  hold.visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hold.visibility });
  rpc.head.mockReset().mockImplementation(async () => chain.head);
  // getLogs は、範囲と受取先の topic で絞った log を返す (本物の RPC と同じ・範囲の制限なし)。
  rpc.logs
    .mockReset()
    .mockImplementation(async (_chainId: number, _forwarder: Address, merchants: Address[], from: bigint, to: bigint) =>
      logsIn(merchants, from, to),
    );
  rpc.time.mockReset().mockImplementation(async (_chainId: number, block: bigint) => blockTime(block));
  rpc.transfers.mockReset().mockImplementation(async () => []);
  warn.mockReset();
});
afterEach(() => {
  // 見張りの module の状態と数を、テストが失敗・時間切れで終わっても次のテストへ持ち越さない。
  stopQrSaleWatch();
  hold.nonces = 0;
  hold.matches = 0;
  hold.appends = 0;
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
    // 初めての回: 先頭 − 90 から「先頭 − 3 (Polygon)」まで。
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    expect(rpc.logs).toHaveBeenCalledWith(POLYGON.chainId, FORWARDER, [getAddress(SHOP)], 910n, 997n);
    // 一致する Settled が無ければ、block の時刻は読まない。
    expect(rpc.time).not.toHaveBeenCalled();
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(2);
  });

  // 通常決済 (mode=standard) の QR は、JPYC の Transfer を読む会計として見張る (tests/lib/qrSaleWatch.standard.test.ts)。
  it('見張らない QR (USDC・金額なし・forwarder の無いチェーン・形の違う bill key) では、RPC を 1 回も読まない', async () => {
    const usdc = buildPayUrl(ORIGIN, { to: SHOP, token: 'usdc', chain: 'base', gas: 'customer', mode: 'gasless', amount: '5' });
    showQrBill({ billKey: BK, kind: 'pay', url: usdc, itemName: '' }, NOW);
    showQrBill({ billKey: BK3, kind: 'pay', url: payUrl({ amount: undefined }), itemName: '' }, NOW);
    showQrBill({ billKey: 'short', kind: 'pay', url: payUrl(), itemName: '' }, NOW);
    hold.forwarders = {};
    showQrBill({ billKey: 'AAAAAAAAAAA', kind: 'pay', url: payUrl(), itemName: '' }, NOW);
    await tick(20);
    expect(rpc.head).not.toHaveBeenCalled();
    expect(rpc.logs).not.toHaveBeenCalled();
    expect(rpc.time).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('初めての回は先頭 − 90 から、次の回は「前回の最後の block − 10」から。Polygon は先頭 − 3 まで・Kaia は先頭 − 1 まで', async () => {
    show();
    await tick();
    chain.head = 1_004n;
    await tick();
    chain.head = 1_004n;
    await tick();
    expect(ranges()).toEqual([[910n, 997n], [987n, 1_001n], [991n, 1_001n]]);
    expect(QR_SALE_OVERLAP_BLOCKS).toBe(10n);

    stopQrSaleWatch();
    rpc.logs.mockClear();
    show(BK2, { chain: 'kaia' });
    await tick();
    expect(rpc.logs).toHaveBeenCalledWith(KAIA.chainId, FORWARDER, [getAddress(SHOP)], 914n, 1_003n);
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

  it('getLogs を読めない回は飛ばし、次の回に同じ範囲の頭から読み直す (rate limit・時間切れ・ほかの error)', async () => {
    show();
    await tick();
    chain.head = 1_010n;
    rpc.logs.mockRejectedValueOnce(Object.assign(new Error('HTTP request failed.'), { status: 429, details: 'Too Many Requests' }));
    await tick();
    chain.head = 1_012n;
    await tick();
    expect(ranges()).toEqual([[910n, 997n], [987n, 1_007n], [987n, 1_009n]]);
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
    hold.nonces = 0;
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
    expect(hold.appends).toBe(0);
    // 金額が会計と同じ 2 つ (乱数の salt・別の bill key) だけ、block の時刻を読み、範囲の全部で nonce を計算した。
    // 別の受取先宛ての Settled は、block の時刻も読まず、nonce も計算しない。
    expect(rpc.time.mock.calls.map(([, block]) => block)).toEqual([990n, 991n]);
    expect(hold.matches).toBe(2);
    expect(hold.nonces).toBe(2 * NONCES_PER_MISS);
    // 重ねて読んだ分は、もう一度確かめない (block の時刻も読まず、判定もし直さない)。
    await tick();
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(3);
    expect(rpc.time).toHaveBeenCalledTimes(2);
    expect(hold.matches).toBe(2);
    expect(hold.nonces).toBe(2 * NONCES_PER_MISS);
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

  it('bill key は合うが金額が会計と違う入金は、行にしない (block の時刻も読まず、nonce も計算しない)。明細の 1 件目も消費しない', async () => {
    show();
    // 別の額・合計は同じで内訳 (着金額と利用料) が違う額を、この会計の bill key で署名した入金。その後に本物の支払い。
    settle(993n, 1, { merchantValue: 498n * ONE, feeValue: 2n * ONE });
    settle(994n, 2, { merchantValue: 997n * ONE, feeValue: 3n * ONE });
    settle(995n, 3);
    hold.nonces = 0;
    await tick();
    // 本物の支払いが、この会計の 1 件目 (明細・管理番号つき)。
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(3)}`]);
    expect(loadHistory()[0]).toMatchObject({ receiptNo: 'R-1', productName: 'ランチ', merchantAmount: (998n * ONE).toString() });
    expect(loadHistory()[0].lineItems).toHaveLength(1);
    expect(marks()).toEqual([tx(3)]);
    // 金額の違う 2 つは、block の時刻を読まず、nonce を 1 回も計算しない (計算したのは本物の支払いが一致するまでの分だけ)。
    expect(rpc.time.mock.calls.map(([, block]) => block)).toEqual([995n]);
    expect(hold.matches).toBe(1);
    expect(hold.nonces).toBe(NONCES_TO_MATCH);
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
    showQrBill({ billKey: BK, kind: 'checkout', url, itemName: '' }, NOW);
    settle(995n, 1, { merchantValue: 1_478n * ONE });
    await tick();
    expect(loadHistory()[0]).toMatchObject({
      id: `batch-${tx(1)}`, productName: 'コーヒー, ケーキ', receiptNo: 'R-0012', saleAmount: (1_480n * ONE).toString(),
    });
    expect(loadHistory()[0].lineItems).toHaveLength(2);
  });

  it('同じ tx に、このお店の会計への一致が 2 つ: 行は最初に見つけた 1 つだけ (tx ごとに 1 行)', async () => {
    show(BK);
    show(BK2, { amount: '300', receiptNo: 'R-2' });
    settle(995n, 1, { logIndex: 0 });
    settle(995n, 1, { logIndex: 1, billKey: BK2, merchantValue: 298n * ONE });
    // BK2 の会計への、別の tx の入金。
    settle(996n, 2, { billKey: BK2, merchantValue: 298n * ONE });
    await tick();
    const byId = Object.fromEntries(loadHistory().map((e) => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual([`batch-${tx(1)}`, `batch-${tx(2)}`]);
    // tx(1) の行は、先に見つけた BK の会計の行 (明細つき)。
    expect(byId[`batch-${tx(1)}`]).toMatchObject({ receiptNo: 'R-1', merchantAmount: (998n * ONE).toString() });
    // BK2 の会計の 1 件目は tx(1) の中の入金だったので、tx(2) は 2 件目 (明細なし)。
    expect(byId[`batch-${tx(2)}`]).toMatchObject({ receiptNo: null, lineItems: null, merchantAmount: (298n * ONE).toString() });
    expect(marks().sort()).toEqual([tx(1), tx(2)]);
    expect(hold.appends).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('取得の途中で会計が増えても (先頭を読む間に別の受取先の QR を出した)、同じ tx の 2 つの一致は 1 行のまま', async () => {
    let release!: (head: bigint) => void;
    rpc.head.mockImplementationOnce(() => new Promise<bigint>((resolve) => { release = resolve; }));
    show(BK);
    await tick();
    // 1 回目が先頭を待っている間に、別の受取先の QR を出す。両方の会計への入金が 1 つの tx に入る。
    show(BK2, { to: OTHER_SHOP, receiptNo: 'R-2' });
    settle(995n, 1, { logIndex: 0 });
    settle(995n, 1, { logIndex: 1, billKey: BK2, merchant: OTHER_SHOP });
    release(1_000n);
    await vi.advanceTimersByTimeAsync(0);
    // 1 回目は、始めた時の受取先 (SHOP) 宛てだけを読んだ。
    expect(rpc.logs.mock.calls[0][2]).toEqual([getAddress(SHOP)]);
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([[`batch-${tx(1)}`, 'R-1']]);
    // 2 回目は両方の受取先を読み、同じ tx の BK2 への一致を見つけるが、tx(1) の行・印があるので書かない。
    await tick();
    expect(rpc.logs.mock.calls[1][2]).toEqual([getAddress(SHOP), getAddress(OTHER_SHOP)]);
    expect(hold.matches).toBe(2);
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([[`batch-${tx(1)}`, 'R-1']]);
    expect(hold.appends).toBe(1);
    expect(marks()).toEqual([tx(1)]);
    expect(warn).not.toHaveBeenCalled();
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
    // 照合し終えた所 (994) の続きから読み直す (994 − 10 = 984 から)。
    expect(ranges()).toEqual([[910n, 997n], [984n, 999n]]);
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

  it('履歴の保存が throw しても、印は残し (外さない)、後ろの入金の記録を続ける。警告は 1 回で、固定のイベント名だけ (例外の本文を出さない)', async () => {
    show();
    settle(994n, 1);
    // 例外の本文に tx が入る場合 (共通の logger の伏せ字の対象外)。
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
    expect(warn.mock.calls).toEqual([['qrSale.row_not_confirmed', {}]]);
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
    hide();
    await tick();
    const dump = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, i) => `${storage.key(i)}=${storage.getItem(storage.key(i)!)}`).join('\n');
    // 履歴の行・tx の印と、履歴の保存が今日の行から作る今日の集計 (lib/history の appendHistory)。
    expect(Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).sort()).toEqual(
      [HISTORY_STORAGE_KEY, QR_SALE_MARKS_KEY, TODAY_SUMMARY_KEY].sort(),
    );
    expect(dump(window.localStorage)).not.toContain(BK);
    expect(dump(window.localStorage)).not.toContain('bk=');
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('照合の量の上限 (同じ金額の会計を出したまま、同じ金額の関係ない入金が届く)', () => {
  it('1 回に照合する (log, 会計) の組は 4 つまで。超える log から後ろを次の回に回し (照合し終えた所の続きから読む)、古い順に全部を照合する', async () => {
    expect(QR_SALE_MAX_PAIRS_PER_PASS).toBe(4);
    // 同じ金額の会計 3 つ。同じ金額の関係ない入金 (乱数の salt) 3 つの後に、BK (最初に出した会計) の本物の支払い。
    show(BK);
    show(BK2, { receiptNo: 'R-2' });
    show(BK3, { receiptNo: 'R-3' });
    settle(990n, 1, { salt: random(0xa1) });
    settle(991n, 2, { salt: random(0xa2) });
    settle(992n, 3, { salt: random(0xa3) });
    settle(993n, 4, { billKey: BK });
    const perPass: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      hold.nonces = 0;
      await tick();
      perPass.push(hold.nonces);
    }
    // 1 回に log 1 つ (3 組) だけ: 次の log まで照合すると 6 組で上限を超える。本物の支払いは最初の会計で一致し、
    // 残りの会計とは照合しない (bill key は会計ごとに違うので、一致する会計は多くても 1 つ)。
    expect(perPass).toEqual([3 * NONCES_PER_MISS, 3 * NONCES_PER_MISS, 3 * NONCES_PER_MISS, NONCES_TO_MATCH]);
    expect(hold.matches).toBe(10);
    // 本物の支払いは BK の会計の 1 件目。
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([[`batch-${tx(4)}`, 'R-1']]);
    // 次の回は、照合し終えた所 (990・991・992) の続き − 10 から。全部を照合し終えた後は前回の最後 (997) の続きから。
    await tick();
    expect(ranges()).toEqual([[910n, 997n], [980n, 997n], [981n, 997n], [982n, 997n], [987n, 997n]]);
  });

  it('組の数がちょうど上限までなら同じ回に照合する。1 つの log の組が上限を超えても、その回の最初の log なら照合する', async () => {
    // 会計 2 つ・関係ない入金 3 つ: 1 回目に log 2 つ (4 組)、2 回目に 1 つ (2 組)。
    show(BK);
    show(BK2);
    settle(990n, 1, { salt: random(0xb1) });
    settle(991n, 2, { salt: random(0xb2) });
    settle(992n, 3, { salt: random(0xb3) });
    hold.nonces = 0;
    await tick();
    expect(hold.nonces).toBe(4 * NONCES_PER_MISS);
    hold.nonces = 0;
    await tick();
    expect(hold.nonces).toBe(2 * NONCES_PER_MISS);

    // 同じ金額の会計 5 つ (1 つの log で 5 組): 5 つ目の会計への本物の支払いも、その回に照合して書く (止まらない)。
    stopQrSaleWatch();
    chain.logs = [];
    const keys = [BK, BK2, BK3, 'AAAAAAAAAAA', 'BBBBBBBBBBB'];
    keys.forEach((key, i) => show(key, { receiptNo: `R-${i}` }));
    settle(995n, 9, { billKey: keys[4] });
    hold.nonces = 0;
    await tick();
    expect(hold.nonces).toBe(4 * NONCES_PER_MISS + NONCES_TO_MATCH);
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([[`batch-${tx(9)}`, 'R-4']]);
  });
});

describe('getLogs の範囲に制限のある RPC (Alchemy の無料枠: 両端を含めて 10 block まで)', () => {
  const rows = () => loadHistory().map((e) => [e.id, e.receiptNo]);
  // Alchemy の無料枠が 11 block 以上の getLogs に返す error (viem が HTTP 400 の応答から作る形)。
  const alchemyRangeError = () =>
    new HttpRequestError({
      url: 'https://rpc.test/v2/key',
      status: 400,
      details: JSON.stringify({
        code: -32600,
        message:
          'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your ' +
          'parameters, this block range should work: [0x3de, 0x3e7]. Upgrade to PAYG for expanded block range.',
      }),
    });
  const rateLimited = () =>
    new HttpRequestError({
      url: 'https://rpc.test/v2/key',
      status: 429,
      details: 'Your app has exceeded its compute units per second capacity.',
    });
  /** 11 block 以上の範囲は error を返す RPC。fail は 10 block までの範囲で、ほかの失敗を差し込む。 */
  const limitedRpc = (fail: (from: bigint, to: bigint) => Error | null = () => null) =>
    rpc.logs.mockImplementation(async (_chainId: number, _forwarder: Address, merchants: Address[], from: bigint, to: bigint) => {
      if (to - from + 1n > QR_SALE_SMALL_RANGE_BLOCKS) throw alchemyRangeError();
      const error = fail(from, to);
      if (error) throw error;
      return logsIn(merchants, from, to);
    });
  // 910 から 997 までを 10 block ずつ。
  const chunks = (from: bigint, to: bigint) => {
    const out: bigint[][] = [];
    for (let start = from; start <= to; start += 10n) out.push([start, start + 9n < to ? start + 9n : to]);
    return out;
  };

  it('初めての回: 1 回で読もうとして範囲の制限の error → 同じ回の中で、古い方から 10 block ずつ読み切って入金を拾う。次の回からは初めから 10 block ずつ', async () => {
    expect(QR_SALE_SMALL_RANGE_BLOCKS).toBe(10n);
    expect(QR_SALE_MAX_GETLOGS_PER_PASS).toBe(10);
    limitedRpc();
    show();
    settle(995n, 1);
    await tick();
    // 範囲の制限を知る 1 回 + 88 block を 10 block ずつ 9 回 = 10 回 (1 回の上限ちょうど)。
    expect(ranges()).toEqual([[910n, 997n], ...chunks(910n, 997n)]);
    expect(rpc.logs).toHaveBeenCalledTimes(10);
    expect(rows()).toEqual([[`batch-${tx(1)}`, 'R-1']]);
    // 次の回は、1 回で読もうとしない (範囲の制限の error を繰り返さない)。重ね (前回 − 10) は同じなので 2 回になる。
    rpc.logs.mockClear();
    chain.head = 1_004n;
    await tick();
    expect(ranges()).toEqual([[987n, 996n], [997n, 1_001n]]);
  });

  it('分けて読む途中の 1 つが失敗したら、読めた所までを照合し、次の回はその続きから読む (読めていない範囲を飛ばさない)', async () => {
    let failed = false;
    limitedRpc((from) => {
      if (from !== 950n || failed) return null;
      failed = true;
      return new Error('upstream 503');
    });
    // QR を出したのは 4 分前。945 と 955 に、この会計への入金 (955 は 2 回目)。
    show(BK, {}, NOW - 240_000);
    settle(945n, 1);
    settle(955n, 2);
    await tick();
    // 1 回目: 940〜949 まで読め、950〜959 で失敗 → 945 だけを照合した。
    expect(ranges()).toEqual([[910n, 997n], ...chunks(910n, 959n)]);
    expect(rows()).toEqual([[`batch-${tx(1)}`, 'R-1']]);
    // 2 回目: 読めた所 (949) − 10 から。955 も読み、2 件目 (明細なし) として書く。
    rpc.logs.mockClear();
    await tick();
    expect(ranges()).toEqual(chunks(939n, 997n));
    expect(rows()).toEqual([
      [`batch-${tx(2)}`, null],
      [`batch-${tx(1)}`, 'R-1'],
    ]);
  });

  it('rate limit (429) が返ったら、その回はそこで止め、次の回に続きから読む。範囲の制限とは覚えない', async () => {
    // 制限の無い RPC で、初めての getLogs が 429 → その回は何も読めない (前回の位置を変えない)。次の回も 1 回で読む。
    rpc.logs.mockRejectedValueOnce(rateLimited());
    show();
    await tick();
    await tick();
    expect(ranges()).toEqual([[910n, 997n], [910n, 997n]]);

    // 制限のある RPC で、分けて読む途中に 429 → 読めた所 (929) までで止め、次の回はその続きから 10 block ずつ。
    stopQrSaleWatch();
    rpc.logs.mockClear();
    let limited = false;
    limitedRpc((from) => {
      if (from !== 930n || limited) return null;
      limited = true;
      return rateLimited();
    });
    show(BK2);
    await tick();
    expect(ranges()).toEqual([[910n, 997n], [910n, 919n], [920n, 929n], [930n, 939n]]);
    rpc.logs.mockClear();
    await tick();
    expect(ranges()).toEqual(chunks(919n, 997n));
  });

  it('範囲の制限の無い RPC は、今までどおり 1 回で読む (初めての回の 88 block も、普段の回も)', async () => {
    show();
    settle(995n, 1);
    await tick();
    chain.head = 1_004n;
    await tick();
    expect(ranges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(rows()).toEqual([[`batch-${tx(1)}`, 'R-1']]);
  });

  it.each([
    ['Alchemy の無料枠 (HTTP 400・details に provider の文面)', alchemyRangeError(), true],
    ['QuickNode', new Error('eth_getLogs is limited to a 10,000 blocks range'), true],
    ['一般の「block range」 (cause の奥)', new Error('request failed', { cause: new Error('block range is too large') }), true],
    ['最大の範囲を超えた', Object.assign(new Error('RPC Request failed.'), { details: 'exceed maximum block range: 5000' }), true],
    ['結果が多すぎる (code -32005)', Object.assign(new Error('query returned more than 10000 results'), { code: -32005 }), true],
    ['関係ない 400', new HttpRequestError({ url: 'https://rpc.test', status: 400, details: 'invalid argument 0: hex string has length 3' }), false],
    ['rate limit (429・Alchemy の文面)', rateLimited(), false],
    ['rate limit の文面に block range が混ざる', new Error('Too many requests for this block range, please slow down'), false],
    ['時間切れ', new Error('qr_sale_rpc_timeout'), false],
    ['error でない値', 'block range', false],
  ])('範囲の制限の error の判定: %s → %s', (_name, error, expected) => {
    expect(isBlockRangeLimitError(error)).toBe(expected);
  });
});

describe('初めての回の範囲と、古い順', () => {
  const rows = () => loadHistory().map((e) => [e.id, e.receiptNo]);

  it('見張りの読み込みが遅れても (表示 → 入金 → 30 秒後に読み込み → 初めての先頭が 18 block 先)、表示した後の入金を拾い、明細は古い方に付く', async () => {
    // QR を出したのは block 1,000 の時刻 (NOW)。見張りが読み込まれて会計が届いたのは 30 秒後。同じ金額の会計が 3 つ。
    vi.setSystemTime(NOW + 30_000);
    show(BK, {}, NOW);
    show(BK2, { receiptNo: 'R-2' }, NOW);
    show(BK3, { receiptNo: 'R-3' }, NOW);
    chain.head = 1_018n;
    settle(1_001n, 1);
    settle(1_005n, 2, { salt: random(0xc1) });
    // 同じ会計への 2 回目の入金 (二重払い) と、同じ block の同じ金額の関係ない入金。
    settle(1_010n, 3);
    settle(1_010n, 4, { salt: random(0xc2), logIndex: 1 });
    await tick(4);
    // 初めての回は先頭 − 90 から (1,001 を覆う)。照合の上限で回した回は、照合し終えた所の続きから。
    expect(ranges()).toEqual([[928n, 1_015n], [994n, 1_015n], [999n, 1_015n], [999n, 1_015n]]);
    expect(rows()).toEqual([
      [`batch-${tx(3)}`, null],
      [`batch-${tx(1)}`, 'R-1'],
    ]);
  });

  it('照合の上限で回すのは後ろの log だけ: 古い log を飛ばして、新しい log を先に照合しない', async () => {
    // log ごとに照合する会計の数が違う順を作る (端末の時計が block の時刻より遅れている)。BK2・BK3 は 50 秒前に出して
    // 40 秒前にやめた (block の時刻で NOW − 80 秒 〜 NOW + 50 秒に生きていた)。BK は表示中。どれも同じ金額。
    show(BK2, { receiptNo: 'R-2' }, NOW - 50_000);
    hide(BK2, NOW - 40_000);
    show(BK3, { receiptNo: 'R-3' }, NOW - 50_000);
    hide(BK3, NOW - 40_000);
    show(BK, {}, NOW - 50_000);
    chain.head = 1_043n;
    settle(1_001n, 1, { salt: random(0xd1) }); // 3 組
    settle(1_002n, 2); // BK の 1 件目: 3 組
    settle(1_040n, 3); // BK の 2 件目 (NOW + 80 秒・BK2 と BK3 は生きていない): 1 組
    // 1 回目: 1,001 (3 組) の後、1,002 は 6 組で上限を超える → 1,002 から後ろ (1,040 も) を次の回へ。
    await tick();
    expect(rows()).toEqual([]);
    // 2 回目: 1,002 (3 組) が BK の 1 件目 (明細つき)・1,040 (1 組・合わせて 4 組) が 2 件目 (明細なし)。
    await tick();
    expect(rows()).toEqual([
      [`batch-${tx(3)}`, null],
      [`batch-${tx(2)}`, 'R-1'],
    ]);
  });

  it('新しい会計が加わった後の回は、先頭 − 90 から読み直す (別の受取先の会計の、見張りに届く前の入金も拾う)', async () => {
    show(BK);
    await tick();
    chain.head = 1_020n;
    await tick();
    // 別の受取先の QR を block 1,000 の時刻に出し、1,003 に入金があった。見張りに会計が届いたのは、その後。
    settle(1_003n, 1, { billKey: BK2, merchant: OTHER_SHOP });
    show(BK2, { to: OTHER_SHOP, receiptNo: 'R-2' }, NOW);
    await tick();
    expect(ranges()).toEqual([[910n, 997n], [987n, 1_017n], [930n, 1_017n]]);
    expect(rows()).toEqual([[`batch-${tx(1)}`, 'R-2']]);
    // その次の回は、前回の続きから。
    await tick();
    expect(ranges().at(-1)).toEqual([1_007n, 1_017n]);
  });
});

describe('表示をやめた後・止めた後', () => {
  it('QR を閉じた後 60 秒は読み続け、その間の入金を行にする。60 秒を過ぎたら読むのをやめる', async () => {
    show();
    await tick();
    hide();
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
    hide();
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
    hide();
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
    expect(() => hide()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('60 秒は、画面の側が渡した「やめた時刻」から数える (hide が届いた時刻からではない)', async () => {
    // 表示を始めたのは 55 秒前・やめたのは 50 秒前 (見張りの読み込みが遅く、今まとめて届いた)。
    show(BK, {}, NOW - 55_000);
    hide(BK, NOW - 50_000);
    // やめてから 56 秒の回は読む。62 秒の回で捨てて、読むのをやめる。
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(1);
    await tick(4);
    expect(rpc.head).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('やめてから 60 秒を過ぎて届いた会計 (見張りの読み込みが遅かった) は持たない。読んでいる途中の回にも使わない', async () => {
    let release!: (logs: QrSaleLog[]) => void;
    show(BK);
    rpc.logs.mockImplementationOnce(() => new Promise<QrSaleLog[]>((resolve) => { release = resolve; }));
    await tick();
    // BK の回が getLogs を待っている間に、80 秒前に出して 70 秒前にやめた会計 (BK2) の show と hide が続けて届く。
    show(BK2, { receiptNo: 'LATE' }, NOW - 80_000);
    hide(BK2, NOW - 70_000);
    // BK2 が生きていた間 (block の時刻 = 今の 50 秒前) に取り込まれた、BK2 の bill key の支払い。
    settle(975n, 1, { billKey: BK2 });
    hold.nonces = 0;
    release(chain.logs);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadHistory()).toEqual([]);
    expect(hold.matches).toBe(0);
    expect(hold.nonces).toBe(0);
  });

  it('読み取りが遅れた入金: 読み終えた時には、やめてから 60 秒を過ぎていても、block の時刻が生きていた間なら書く', async () => {
    show();
    await tick();
    hide();
    const hiddenAt = Date.now();
    // やめてから 48 秒まで、入金は無い。
    await tick(8);
    chain.head = 1_020n;
    // block の時刻 = やめた 14 秒後 (生きていた間)。
    settle(1_010n, 1);
    // やめてから 54 秒に始まる回の getLogs が 6.5 秒かかる (読み終えるのは、やめてから 60.5 秒)。
    rpc.logs.mockImplementationOnce(
      (_chainId: number, _forwarder: Address, _merchants: Address[], from: bigint, to: bigint) =>
        new Promise<QrSaleLog[]>((resolve) => {
          setTimeout(() => resolve(chain.logs.filter((log) => log.blockNumber! >= from && log.blockNumber! <= to)), 6_500);
        }),
    );
    await tick();
    await vi.advanceTimersByTimeAsync(6_500);
    expect(Date.now() - hiddenAt).toBeGreaterThan(QR_SALE_KEEP_AFTER_HIDE_MS);
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([[`batch-${tx(1)}`, 'R-1']]);
  });

  it('block の時刻が、会計の生きていた間 (表示を始めてから、やめて 60 秒まで・時計のずれ 30 秒) の外なら書かない', async () => {
    expect(QR_SALE_CLOCK_SKEW_MS).toBe(30_000);
    // 表示を始めた時刻 = やめた時刻 = NOW。生きていた間 = block の時刻が NOW − 30 秒 〜 NOW + 90 秒。
    show(BK, {}, NOW);
    hide(BK, NOW);
    rpc.logs.mockImplementation(async () => chain.logs);
    settle(984n, 1); // NOW − 32 秒: 外
    settle(985n, 2); // NOW − 30 秒: 内 (端)
    settle(1_045n, 3); // NOW + 90 秒: 内 (端)
    settle(1_046n, 4); // NOW + 92 秒: 外
    hold.nonces = 0;
    await tick();
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([
      [`batch-${tx(3)}`, null],
      [`batch-${tx(2)}`, 'R-1'],
    ]);
    // 外の 2 つは照合しない (nonce を計算しない)。
    expect(hold.matches).toBe(2);
    expect(hold.nonces).toBe(2 * NONCES_TO_MATCH);
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
    expect(ranges()).toEqual([[4_910n, 4_997n]]);
    expect(loadHistory().map((e) => [e.id, e.receiptNo])).toEqual([[`batch-${tx(2)}`, 'NEXT']]);
  });

  it('外に出す関数は throw しない (会計の写しを読めない・RPC が壊れた値を返す)', async () => {
    expect(() => showQrBill({ billKey: BK, kind: 'pay', url: 'not a url', itemName: '' }, NOW)).not.toThrow();
    expect(() =>
      showQrBill({ billKey: BK, kind: 'checkout', url: `${ORIGIN}/checkout?items=%%%`, itemName: '' }, NOW),
    ).not.toThrow();
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

describe('画面への知らせ (印を書いた後だけ・書けなかったかもしれないときは notSaved・受け手の失敗は見張りへ波及させない)', () => {
  // 受け手つきで QR を出す (画面の側 = hooks/useQrBillKey.ts が渡すもの)。
  const showWith = (listener: (event: QrBillRecorded) => void, billKey = BK, over: Partial<PayParams> = {}) =>
    showQrBill(
      { billKey, kind: 'pay', url: payUrl({ productName: 'ランチ', receiptNo: 'R-1', ...over }), itemName: 'お支払い' },
      Date.now(),
      listener,
    );

  it('1 件目 → count 1・2 件目以降 → count 2, 3 (明細つきの行・明細なしの行の数え方と同じ)。額は書いた行の saleAmount (請求額)', async () => {
    const events: QrBillRecorded[] = [];
    showWith((e) => events.push(e));
    settle(994n, 1);
    settle(995n, 2);
    await tick();
    expect(events).toEqual([
      { billKey: BK, count: 1, amount: (1_000n * ONE).toString() },
      { billKey: BK, count: 2, amount: (1_000n * ONE).toString() },
    ]);
    // 知らせの額 = 書いた行の売上総額 (着金額 998 + 利用料 2)。着金額 (merchantAmount) ではない。
    const byId = Object.fromEntries(loadHistory().map((e) => [e.id, e]));
    expect(byId[`batch-${tx(1)}`].saleAmount).toBe(events[0].amount);
    expect(byId[`batch-${tx(1)}`].merchantAmount).not.toBe(events[0].amount);
    // 1 件目 = 明細つきの行・2 件目 = 明細なしの行。
    expect(byId[`batch-${tx(1)}`].lineItems).toHaveLength(1);
    expect(byId[`batch-${tx(2)}`].lineItems).toBeNull();
    chain.head = 1_004n;
    settle(1_000n, 3);
    await tick();
    expect(events.at(-1)).toEqual({ billKey: BK, count: 3, amount: (1_000n * ONE).toString() });
  });

  it('会計ごとに知らせる (別の会計の入金は、その会計の受け手だけに届く)', async () => {
    const a: QrBillRecorded[] = [];
    const b: QrBillRecorded[] = [];
    showWith((e) => a.push(e), BK);
    showWith((e) => b.push(e), BK2, { amount: '700' });
    settle(995n, 1, { billKey: BK2, merchantValue: 698n * ONE });
    await tick();
    expect(a).toEqual([]);
    expect(b).toEqual([{ billKey: BK2, count: 1, amount: (700n * ONE).toString() }]);
  });

  it('同じ bill key を出し直したら (StrictMode の 出す → やめる → 出す)、新しい受け手に知らせる', async () => {
    const first = vi.fn();
    const second = vi.fn();
    showWith(first);
    hide();
    showWith(second);
    settle(995n, 1);
    await tick();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('行を書かなかった入金は知らせない (同じ tx の行が履歴にある・自分の印がある・一致しない入金)', async () => {
    const listener = vi.fn();
    window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify([[tx(2), 1]]));
    appendHistory(
      buildHistoryEntry({
        flow: 'batch', status: 'success', chainId: POLYGON.chainId, chainSlug: 'polygon', asset: 'jpyc',
        tokenAddress: POLYGON.address, payMode: 'gasless', gasMode: 'merchant', merchant: SHOP,
        merchantAmount: 998n * ONE, customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 0n,
        txHash: tx(1), userOpHash: null, blockNumber: null, errorMessage: null, storeName: 'payer wrote this',
      }),
    );
    expect(loadHistory()).toHaveLength(1);
    showWith(listener);
    settle(993n, 1);
    settle(994n, 2);
    settle(995n, 3, { salt: random(9) });
    await tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it('履歴の保存が throw したとき・書き込みが黙って失敗したとき (容量の上限) は「記録しました」と言わず、書けなかったかもしれないと知らせる', async () => {
    const events: QrBillRecorded[] = [];
    showWith((e) => events.push(e));
    settle(994n, 1);
    hold.failAppend = true;
    await tick();
    hold.failAppend = false;
    expect(events).toEqual([{ billKey: BK, count: 1, amount: (1_000n * ONE).toString(), notSaved: true }]);
    // appendHistory は localStorage の失敗を握りつぶして返る: 行の key への書き込みだけを失敗させる。
    chain.head = 1_002n;
    settle(999n, 2);
    const real = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === HISTORY_STORAGE_KEY) throw new Error('QuotaExceededError');
      real.call(this, key, value);
    });
    await tick();
    setItem.mockRestore();
    expect(hold.appends).toBe(2);
    expect(loadHistory()).toEqual([]);
    expect(events).toEqual([
      { billKey: BK, count: 1, amount: (1_000n * ONE).toString(), notSaved: true },
      { billKey: BK, count: 2, amount: (1_000n * ONE).toString(), notSaved: true },
    ]);
  });

  it('このタブが印を書いた後に行を読み直せなかった: 印は残り、後から当たっても書き直さない (知らせも 1 回)。警告 qrSale.row_not_confirmed は 1 回で、tx・bill key を出さない', async () => {
    const events: QrBillRecorded[] = [];
    showWith((e) => events.push(e));
    settle(995n, 1);
    const real = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === HISTORY_STORAGE_KEY) throw new Error('QuotaExceededError');
      real.call(this, key, value);
    });
    await tick();
    setItem.mockRestore();
    expect(marks()).toEqual([tx(1)]);
    expect(events).toEqual([{ billKey: BK, count: 1, amount: (1_000n * ONE).toString(), notSaved: true }]);
    // 書けるようになっても、組み直し (reorg) で同じ tx が別の log の番号で届いても、印で止まる (書き直しはしない)。
    chain.logs[0] = { ...chain.logs[0], logIndex: 5 };
    await tick(2);
    expect(loadHistory()).toEqual([]);
    expect(hold.appends).toBe(1);
    expect(events).toHaveLength(1);
    // 固定のイベント名だけ (tx・bill key・例外を渡さない)。ほかの警告は storage の共通の読み書きのもの (lib/storage.ts)。
    expect(warn.mock.calls.filter(([name]) => name.startsWith('qrSale.'))).toEqual([['qrSale.row_not_confirmed', {}]]);
  });

  it('「行を読み直せなかった」の警告は、ほかの警告 (例外つき) と別に 1 回: この警告の後の notify_failed も出る (main より原因を追えなくしない)', async () => {
    showWith(() => {
      throw new Error('listener down');
    });
    settle(995n, 1);
    hold.failAppend = true;
    await tick();
    const names = warn.mock.calls.map(([name]) => name).filter((name) => String(name).startsWith('qrSale.'));
    expect(names).toEqual(['qrSale.row_not_confirmed', 'qrSale.notify_failed']);
  });

  it('印を確かめた後・印を書く前に、別のタブが同じ tx の印を書いた: 保存の流れは今までどおり (行を書きにいく) で、読み直せなくても notSaved を知らせない', async () => {
    const listener = vi.fn();
    showWith(listener);
    settle(995n, 1);
    hold.failAppend = true;
    const real = Storage.prototype.getItem;
    let reads = 0;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      // 保存の直前の確認 (1 回目の読み取り) の後、印を書く所 (2 回目) の前に、別のタブの印が届く。
      if (key === QR_SALE_MARKS_KEY && ++reads === 2) {
        window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify([[tx(1), 1]]));
      }
      return real.call(this, key);
    });
    await tick();
    getItem.mockRestore();
    expect(reads).toBe(2);
    // 行は今までどおり書きにいく (addQrSaleMark が true を返す流れ)。印は別のタブのまま。
    expect(hold.appends).toBe(1);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBe(JSON.stringify([[tx(1), 1]]));
    expect(loadHistory()).toEqual([]);
    // このタブは印を書いていないので、「書けなかったかもしれない」を出さない。
    expect(listener).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([['qrSale.row_not_confirmed', {}]]);
  });

  it('同じ順で別のタブの印が届いても、行を読み直せたら今までどおり知らせる (count 1・notSaved なし)', async () => {
    const events: QrBillRecorded[] = [];
    showWith((e) => events.push(e));
    settle(995n, 1);
    const real = Storage.prototype.getItem;
    let reads = 0;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === QR_SALE_MARKS_KEY && ++reads === 2) {
        window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify([[tx(1), 1]]));
      }
      return real.call(this, key);
    });
    await tick();
    getItem.mockRestore();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(1)}`]);
    expect(events).toEqual([{ billKey: BK, count: 1, amount: (1_000n * ONE).toString() }]);
  });

  it('1 件目が書けず 2 件目が書けた: 1 件目は notSaved つき (count 1)、2 件目は今までどおり (count 2・notSaved なし)', async () => {
    const events: QrBillRecorded[] = [];
    showWith((e) => events.push(e));
    settle(994n, 1);
    settle(995n, 2);
    hold.failNext = 1;
    await tick();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(2)}`]);
    expect(events).toEqual([
      { billKey: BK, count: 1, amount: (1_000n * ONE).toString(), notSaved: true },
      { billKey: BK, count: 2, amount: (1_000n * ONE).toString() },
    ]);
  });

  it('別のタブ・受注の書き手の印があって書かなかった入金は、保存が壊れていても知らせない', async () => {
    const listener = vi.fn();
    window.localStorage.setItem(QR_SALE_MARKS_KEY, JSON.stringify([[tx(1), 1]]));
    window.localStorage.setItem(ORDER_SALE_MARKS_KEY, JSON.stringify([[tx(2), 1]]));
    showWith(listener);
    settle(994n, 1);
    settle(995n, 2);
    hold.failAppend = true;
    await tick();
    expect(hold.appends).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([name]) => name === 'qrSale.row_not_confirmed')).toHaveLength(0);
  });

  it('受け手が throw しても、行は書かれ、同じ回の後ろの入金も次の回も記録を続ける。警告は qrSale.notify_failed', async () => {
    const listener = vi.fn(() => {
      throw new Error('setState failed');
    });
    showWith(listener);
    settle(994n, 1);
    settle(995n, 2);
    await tick();
    expect(loadHistory().map((e) => e.id)).toEqual([`batch-${tx(2)}`, `batch-${tx(1)}`]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('qrSale.notify_failed');
    // 見張りは続く (次の回も読み、次の入金も書く)。
    const reads = rpc.head.mock.calls.length;
    chain.head = 1_004n;
    settle(1_000n, 3);
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(reads + 1);
    expect(loadHistory()[0].id).toBe(`batch-${tx(3)}`);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('受け手を渡さない (今までの呼び方) なら、行を書くだけ', async () => {
    show();
    settle(995n, 1);
    await tick();
    expect(loadHistory()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
