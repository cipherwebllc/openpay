// lib/qrSaleWatch.ts の「ガスレスの会計の、切り替えた入金」: ガスレスの QR (mode=gasless・JPYC) を、払う側の画面で通常決済に
// 切り替えて払った入金 (ガスレスで払えない ERC-4337 のウォレットなど) を、受取先に届いた JPYC の Transfer と、その tx の input の印
// (transfer(受取先, 額) + bill key の印) で確かめて、取引履歴に通常決済の行を書く。Settled の入金と、会計の件数・明細・
// 1 tx 1 行・知らせを共有する。
// RPC の読み取り (lib/qrSaleRpc.ts) と nonce の式 (軽い差し替え) を差し替え、照合・行の組み立て・履歴と印 (localStorage) は実物。
// 時間は fake timer で進める。ガスレスの入金だけの回し方は tests/lib/qrSaleWatch.test.ts、通常決済の QR の会計は
// tests/lib/qrSaleWatch.standard.test.ts が確かめる (この file は、切り替えた入金の段と、それが今までの回に重なる所を見る)。
// 約束 (lib/qrSaleWatch.ts の頭の注記): (1) Settled と通常決済の会計の記録は今までと同じ時機・同じ結果 (1 回は、全チェーンの
// 今までの回を終えてから、切り替えた入金を読む) (2) 切り替えた入金が行を書くのは、その tx の block が、同じ回の Settled が照合し
// 終えた範囲の中にあり、会計が回の始まりにあったときだけ (3) 1 つの tx を同じ会計に数えるのは 1 回 (4) 切り替えた入金の失敗は
// 共有の状態を変えない。切り替えた入金はベストエフォート (位置を持たない・読めなかった分は行にならないだけ)。
// 切り替えた入金の getLogs は rpc.switched (readSwitchedTransferLogs)・通常決済の会計の getLogs は rpc.transfers。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  encodeFunctionData,
  getAddress,
  HttpRequestError,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

const rpc = vi.hoisted(() => ({
  head: vi.fn(), logs: vi.fn(), time: vi.fn(), transfers: vi.fn(), switched: vi.fn(), tx: vi.fn(),
}));
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
  readTransferLogs: rpc.transfers,
  readSwitchedTransferLogs: rpc.switched,
  readTransaction: rpc.tx,
}));
const hold = vi.hoisted(() => ({
  forwarders: {} as Record<number, string>,
  appends: 0,
  visibility: 'visible' as 'visible' | 'hidden',
}));
// nonce の式は軽い差し替え (tests/_helpers/fakeForwarderNonce.ts)。
vi.mock('@/lib/relay/forwarderIntent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/relay/forwarderIntent')>();
  const { createFakeForwarderNonce } = await import('@/tests/_helpers/fakeForwarderNonce');
  const fake = createFakeForwarderNonce();
  return { ...actual, buildForwarderNonce: (...args: Parameters<typeof actual.buildForwarderNonce>) => fake(...args) };
});
vi.mock('@/lib/relay/forwarderConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/relay/forwarderConfig')>()),
  jpycForwarderFor: (chainId: number) => hold.forwarders[chainId] ?? null,
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } }));
// 履歴は実物。書いた回数だけ数える。
vi.mock('@/lib/history', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/history')>();
  return {
    ...actual,
    appendHistory: (entry: Parameters<typeof actual.appendHistory>[0]) => {
      hold.appends += 1;
      actual.appendHistory(entry);
    },
  };
});

import { env } from '@/lib/env';
import { appendHistory, buildHistoryEntry, HISTORY_STORAGE_KEY, loadHistory } from '@/lib/history';
import { QR_SALE_MARKS_KEY } from '@/lib/qrSaleMarks';
import type { QrSaleLog, QrSaleTx } from '@/lib/qrSaleRpc';
import {
  QR_SALE_MAX_GETLOGS_PER_PASS,
  QR_SALE_MAX_TX_READS_PER_PASS,
  QR_SALE_POLL_MS,
  QR_SALE_SMALL_RANGE_BLOCKS,
  hideQrBill,
  showQrBill,
  stopQrSaleWatch,
  type QrBillRecorded,
} from '@/lib/qrSaleWatch';
import { recoverFeeValue } from '@/lib/relay/recoverFee';
import { deploymentForSlug } from '@/lib/tokens';
import { buildCheckoutUrl, buildPayUrl, type PayParams } from '@/lib/url';
import { billNonce, markedTransfer, plainTransfer, settledRpcLog, transferRpcLog } from '../_helpers/qrSale';

const ORIGIN = 'https://shop.test';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER_SHOP: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER_CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
// スマートアカウントの tx を送る bundler と、ERC-4337 の EntryPoint (v0.7)。
const BUNDLER: Address = '0x4337000000000000000000000000000000000001';
const ENTRY_POINT: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const BK = 'Zm9vYmFyYmE';
const BK2 = 'a-b_c-d_e-8';
const BK3 = 'QQQQQQQQQQQ';
const ONE = 10n ** 18n;
const POLYGON = deploymentForSlug('jpyc', 'polygon');
// 10 block ずつ読むチェーンの場面で使う (Avalanche の JPYC はテストの env では OFF。Kaia も Avalanche と同じく先頭 − 1 まで読む)。
const KAIA = deploymentForSlug('jpyc', 'kaia');
const JPYC = POLYGON.address;
// 請求 1,000 JPYC の会計: ガスレス (Settled) なら着金 = 1,000 − 回収の額・利用料 = 回収の額。通常決済 (Transfer) なら 1,000。
const BILL = 1_000n * ONE;
const FEE = recoverFeeValue(BILL, 'merchant', POLYGON.chainId);
const NET = BILL - FEE;
const KAIA_FEE = recoverFeeValue(BILL, 'merchant', KAIA.chainId);
const NOW = Date.UTC(2026, 10, 18, 6, 0, 0);
// block n の時刻 (unix 秒)。block 1,000 = NOW・1 block 2 秒。
const blockTime = (n: bigint) => BigInt(NOW / 1000) + (n - 1_000n) * 2n;
// 16 進の英字を含む hash。
const tx = (n: number) => `0x${'ef'.repeat(24)}${n.toString(16).padStart(16, '0')}` as Hex;

// スマートアカウントが中で transfer を呼ぶ tx の input の形。
const HANDLE_OPS = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
]);
const ACCOUNT = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
]);

/** ERC-4337 (EntryPoint v0.7) の bundler が送る handleOps。UserOp の callData = 口座の execute / executeBatch。 */
function handleOps(callData: Hex): Hex {
  return encodeFunctionData({
    abi: HANDLE_OPS,
    functionName: 'handleOps',
    args: [
      [
        {
          sender: CUSTOMER, nonce: 7n, initCode: '0x', callData, accountGasLimits: pad('0x0186a0'),
          preVerificationGas: 50_000n, gasFees: pad('0x3b9aca00'), paymasterAndData: `0x${'aa'.repeat(52)}`,
          signature: `0x${'11'.repeat(65)}`,
        },
      ],
      BUNDLER,
    ],
  });
}
const execute = (inner: Hex) => encodeFunctionData({ abi: ACCOUNT, functionName: 'execute', args: [JPYC, 0n, inner] });
const executeBatch = (inners: Hex[]) =>
  encodeFunctionData({ abi: ACCOUNT, functionName: 'executeBatch', args: [inners.map(() => JPYC), inners.map(() => 0n), inners] });
/** 同じ会計の Settled と Transfer の両方が一致する tx の、Transfer の側の input (スマートアカウントが中で印つきの transfer を呼ぶ)。 */
const wrapped = (billKey = BK, to: Address = SHOP) => handleOps(execute(markedTransfer(billKey, to, BILL)));

// チェーンの代わり: 先頭の block と、取り込まれた Transfer・Settled の log と、tx。
const chain = {
  head: 1_000n,
  transfers: [] as QrSaleLog[],
  settled: [] as QrSaleLog[],
  txs: new Map<string, QrSaleTx>(),
};

const gaslessUrl = (over: Partial<PayParams> = {}) =>
  buildPayUrl(ORIGIN, { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', amount: '1000', ...over });
/** ガスレスの QR を出す (既定 = 1,000 JPYC・Polygon・管理番号 G-1)。 */
const showGasless = (
  billKey = BK,
  over: Partial<PayParams> = {},
  shownAt = Date.now(),
  listener?: (e: QrBillRecorded) => void,
) =>
  showQrBill(
    { billKey, kind: 'pay', url: gaslessUrl({ productName: 'ランチ', receiptNo: 'G-1', ...over }), itemName: 'お支払い' },
    shownAt,
    listener,
  );
/** 通常決済の QR を出す (既定 = 1,000 JPYC・Polygon・管理番号 S-1)。 */
const showStd = (
  billKey: string,
  over: Partial<PayParams> = {},
  shownAt = Date.now(),
  listener?: (e: QrBillRecorded) => void,
) =>
  showQrBill(
    {
      billKey,
      kind: 'pay',
      url: gaslessUrl({ gas: 'customer', mode: 'standard', productName: '定食', receiptNo: 'S-1', ...over }),
      itemName: 'お支払い',
    },
    shownAt,
    listener,
  );

/**
 * block に Transfer を足し、その tx を登録する (既定 = お客様の EOA が JPYC へ直接 transfer(受取先, 1,000) + BK の印 =
 * ガスレスの QR を読んで、払う側で通常決済に切り替えて払った送金)。
 */
function pay(
  block: bigint,
  n: number,
  over: {
    billKey?: string; value?: bigint; from?: Address; to?: Address; token?: Address; logIndex?: number;
    input?: Hex; txFrom?: Address; txTo?: Address | null; txHash?: string;
  } = {},
) {
  const value = over.value ?? BILL;
  const to = over.to ?? SHOP;
  const token = over.token ?? JPYC;
  const hash = over.txHash ?? tx(n);
  chain.transfers.push(
    transferRpcLog({
      token, from: over.from ?? CUSTOMER, to, value, txHash: hash, blockNumber: block, logIndex: over.logIndex ?? 0,
    }),
  );
  chain.txs.set(hash.toLowerCase(), {
    from: over.txFrom ?? over.from ?? CUSTOMER,
    to: over.txTo === undefined ? token : over.txTo,
    input: over.input ?? markedTransfer(over.billKey ?? BK, to, value),
  });
  return hash;
}

/** ガスレスの入金の Settled を足す (既定 = BK の署名・1,000 JPYC の会計どおり = 着金 1,000 − 回収の額・利用料 = 回収の額)。 */
function settle(
  block: bigint,
  n: number,
  over: {
    billKey?: string; merchant?: Address; merchantValue?: bigint; feeValue?: bigint; logIndex?: number; txHash?: string;
    chainId?: number;
  } = {},
) {
  const sale = {
    from: CUSTOMER, merchant: over.merchant ?? SHOP, merchantValue: over.merchantValue ?? NET, feeValue: over.feeValue ?? FEE,
    validBefore: blockTime(block) + 290n, chainId: over.chainId ?? POLYGON.chainId, forwarder: FORWARDER,
  };
  chain.settled.push(
    settledRpcLog({
      ...sale, nonce: billNonce(over.billKey ?? BK, sale), txHash: over.txHash ?? tx(n), blockNumber: block,
      logIndex: over.logIndex ?? 0,
    }),
  );
}

const topicAddress = (topic: string) => getAddress(`0x${topic.slice(26)}`);
const inRange = (log: QrSaleLog, from: bigint, to: bigint) => log.blockNumber! >= from && log.blockNumber! <= to;
/** チェーンの Transfer のうち、範囲 (両端を含む) と受取先の topic に当たるもの (本物の getLogs の絞り込み)。 */
const transfersIn = async (_chainId: number, _token: Address, merchants: Address[], from: bigint, to: bigint) =>
  chain.transfers.filter(
    (log) => inRange(log, from, to) && merchants.some((m) => topicAddress(log.topics[2]!) === getAddress(m)),
  );
const tick = (times = 1) => vi.advanceTimersByTimeAsync(QR_SALE_POLL_MS * times);
/** 切り替えた入金の getLogs の範囲。 */
const switchedRanges = () => rpc.switched.mock.calls.map(([, , , from, to]) => [from, to]);
/** 通常決済の会計の getLogs の範囲。 */
const transferRanges = () => rpc.transfers.mock.calls.map(([, , , from, to]) => [from, to]);
const settledRanges = () => rpc.logs.mock.calls.map(([, , , from, to]) => [from, to]);
const rows = () => loadHistory().map((e) => [e.id, e.receiptNo]);
const marks = () =>
  (JSON.parse(window.localStorage.getItem(QR_SALE_MARKS_KEY) ?? '[]') as [string, number][]).map(([hash]) => hash);
const stdId = (hash: string) => `standard-merchant-${hash}`;
const gaslessId = (hash: string) => `batch-${hash}`;
const down = () => new HttpRequestError({ url: 'https://rpc.test', status: 503, details: 'upstream down' });
const never = <T>() => new Promise<T>(() => {});
/** 印 (tx の印の保存) の書き込みを、1 回だけ失敗させる。返す関数で元に戻す。 */
function failMarkWriteOnce() {
  const real = Storage.prototype.setItem;
  const state = { failed: false };
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === QR_SALE_MARKS_KEY && !state.failed) {
      state.failed = true;
      throw new Error('QuotaExceededError');
    }
    real.call(this, key, value);
  });
  return { state, restore: () => spy.mockRestore() };
}
/** 履歴の行の書き込みを失敗させる (印は書ける)。返す関数で元に戻す。 */
function failHistoryWrite() {
  const real = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === HISTORY_STORAGE_KEY) throw new Error('QuotaExceededError');
    real.call(this, key, value);
  });
  return () => spy.mockRestore();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  chain.head = 1_000n;
  chain.transfers = [];
  chain.settled = [];
  chain.txs = new Map();
  hold.forwarders = { [POLYGON.chainId]: FORWARDER, [KAIA.chainId]: FORWARDER };
  hold.appends = 0;
  hold.visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hold.visibility });
  rpc.head.mockReset().mockImplementation(async () => chain.head);
  // getLogs は、範囲と受取先の topic で絞った log を返す (本物の RPC と同じ・範囲の制限なし)。
  rpc.transfers.mockReset().mockImplementation(transfersIn);
  rpc.switched.mockReset().mockImplementation(transfersIn);
  rpc.logs
    .mockReset()
    .mockImplementation(async (_chainId: number, _forwarder: Address, merchants: Address[], from: bigint, to: bigint) =>
      chain.settled.filter(
        (log) => inRange(log, from, to) && merchants.some((m) => topicAddress(log.topics[3]!) === getAddress(m)),
      ),
    );
  rpc.time.mockReset().mockImplementation(async (_chainId: number, block: bigint) => blockTime(block));
  rpc.tx.mockReset().mockImplementation(async (_chainId: number, hash: string) => {
    const found = chain.txs.get(hash.toLowerCase());
    if (!found) throw new Error('TransactionNotFoundError');
    return found;
  });
  warn.mockReset();
});
afterEach(() => {
  stopQrSaleWatch();
  hold.appends = 0;
  Reflect.deleteProperty(document, 'visibilityState');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ガスレスの会計: 読むもの', () => {
  it('この file の会計: 回収の額は 0 より大きい (Settled の着金額と、通常決済の額が違う)', () => {
    expect(FEE > 0n).toBe(true);
    expect(NET < BILL).toBe(true);
  });

  it('ガスレスの QR を出したら、6 秒おきに Settled → 切り替えた入金の順に、同じ範囲を 1 回ずつ読む (先頭は 1 回・通常決済の会計の getLogs は読まない・位置は持たない)', async () => {
    showGasless();
    expect(rpc.head).not.toHaveBeenCalled();
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(1);
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    expect(rpc.logs).toHaveBeenCalledWith(POLYGON.chainId, FORWARDER, [getAddress(SHOP)], 910n, 997n);
    expect(rpc.switched).toHaveBeenCalledTimes(1);
    expect(rpc.switched).toHaveBeenCalledWith(POLYGON.chainId, JPYC, [getAddress(SHOP)], 910n, 997n);
    expect(rpc.logs.mock.invocationCallOrder[0]).toBeLessThan(rpc.switched.mock.invocationCallOrder[0]);
    expect(rpc.transfers).not.toHaveBeenCalled();
    // 受取先・額の合う log が無ければ、block の時刻も tx も読まない。
    expect(rpc.time).not.toHaveBeenCalled();
    expect(rpc.tx).not.toHaveBeenCalled();
    chain.head = 1_004n;
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(2);
    // 切り替えた入金は位置を持たない: 毎回、その回の Settled が照合し終えた範囲 (重ねを含む) と同じ範囲を読む。
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(switchedRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
  });

  it('見張らないガスレスの QR (USDC・金額なし・形の違う bill key・forwarder の無いチェーン) では、RPC を 1 回も読まない (今までどおり)', async () => {
    // Kaia に forwarder が無い build。
    hold.forwarders = { [POLYGON.chainId]: FORWARDER };
    const usdc = buildPayUrl(ORIGIN, { to: SHOP, token: 'usdc', chain: 'base', gas: 'customer', mode: 'gasless', amount: '5' });
    showQrBill({ billKey: BK, kind: 'pay', url: usdc, itemName: '' }, NOW);
    showQrBill({ billKey: BK2, kind: 'pay', url: gaslessUrl({ amount: undefined }), itemName: '' }, NOW);
    showQrBill({ billKey: 'short', kind: 'pay', url: gaslessUrl(), itemName: '' }, NOW);
    showQrBill({ billKey: BK3, kind: 'pay', url: gaslessUrl({ chain: 'kaia' }), itemName: '' }, NOW);
    await tick(20);
    expect(rpc.head).not.toHaveBeenCalled();
    expect(rpc.logs).not.toHaveBeenCalled();
    expect(rpc.switched).not.toHaveBeenCalled();
    expect(rpc.transfers).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('新しいガスレスの会計が加わった回: Settled が先頭 − 90 から読み直す (今までどおり) ので、切り替えた入金も同じ範囲。新しい通常決済の会計では、どちらも続きのまま', async () => {
    showGasless(BK);
    await tick();
    chain.head = 1_004n;
    await tick();
    chain.head = 1_008n;
    showGasless(BK2, { to: OTHER_SHOP });
    await tick();
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n], [918n, 1_005n]]);
    expect(switchedRanges()).toEqual(settledRanges());
    // 受取先は、その回の始まりにあった会計を合わせて 1 回で読む。
    expect(rpc.logs.mock.calls[2][2]).toEqual([getAddress(SHOP), getAddress(OTHER_SHOP)]);
    expect(rpc.switched.mock.calls[2][2]).toEqual([getAddress(SHOP), getAddress(OTHER_SHOP)]);
    chain.head = 1_012n;
    showStd(BK3);
    await tick();
    // 通常決済の会計は、今までどおり自分の種類 (Transfer) の位置だけを新しく読む。Settled は続きから・切り替えた入金も同じ範囲。
    expect(settledRanges()[3]).toEqual([995n, 1_009n]);
    expect(switchedRanges()[3]).toEqual([995n, 1_009n]);
    expect(rpc.transfers.mock.calls.map(([, , merchants, from, to]) => [merchants, from, to])).toEqual([
      [[getAddress(SHOP)], 922n, 1_009n],
    ]);
  });

  it('同じ受取先の新しいガスレスの会計への切り替えた入金は、次の回に拾う', async () => {
    showGasless(BK);
    await tick();
    chain.head = 1_004n;
    showGasless(BK2);
    pay(1_000n, 1, { billKey: BK2 });
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
  });

  it('通常決済の QR とガスレスの QR が同じチェーンに同時にある: 種類ごとに 1 回ずつ読む (通常決済の会計の getLogs は、その会計の受取先だけ = 今までどおり)', async () => {
    showGasless(BK);
    showStd(BK2, { to: OTHER_SHOP });
    await tick();
    expect(rpc.logs.mock.calls.map(([, , merchants]) => merchants)).toEqual([[getAddress(SHOP)]]);
    expect(rpc.transfers.mock.calls.map(([, token, merchants, from, to]) => [token, merchants, from, to])).toEqual([
      [JPYC, [getAddress(OTHER_SHOP)], 910n, 997n],
    ]);
    expect(rpc.switched.mock.calls.map(([, token, merchants, from, to]) => [token, merchants, from, to])).toEqual([
      [JPYC, [getAddress(SHOP)], 910n, 997n],
    ]);
    // 読む順: Settled → 通常決済の会計の Transfer → 切り替えた入金。
    const order = [rpc.logs, rpc.transfers, rpc.switched].map((fn) => fn.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('払う側で通常決済に切り替えた入金 → 通常決済の行', () => {
  it('請求額ちょうどの Transfer + 印 (EOA が JPYC へ直接送った) → 通常決済の行: 会計の写しの明細つき・お客様は Transfer の from・時刻は block の時刻', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    pay(995n, 1);
    await tick();
    expect(rpc.time).toHaveBeenCalledWith(POLYGON.chainId, 995n);
    expect(rpc.tx).toHaveBeenCalledWith(POLYGON.chainId, tx(1));
    const all = loadHistory();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: stdId(tx(1)),
      ts: Number(blockTime(995n)) * 1000,
      flow: 'standard-merchant',
      status: 'success',
      chainId: POLYGON.chainId,
      chainSlug: 'polygon',
      asset: 'jpyc',
      tokenAddress: JPYC,
      payMode: 'standard',
      gasMode: null,
      merchant: getAddress(SHOP),
      customer: getAddress(CUSTOMER),
      merchantAmount: BILL.toString(),
      feeAmount: '0',
      saleAmount: BILL.toString(),
      networkFeeEquivalent: null,
      feeReceiver: env.feeReceiver,
      txHash: tx(1),
      userOpHash: null,
      blockNumber: '995',
      errorMessage: null,
      productName: 'ランチ',
      receiptNo: 'G-1',
    });
    expect(all[0].lineItems).toHaveLength(1);
    expect(marks()).toEqual([tx(1)]);
    // 知らせは、ガスレスの入金と同じ形 (何件目か・額 = 請求額)。
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
  });

  it.each([
    ['ERC-4337 の bundler の handleOps (口座の execute)', () => handleOps(execute(markedTransfer(BK, SHOP, BILL))), BUNDLER, ENTRY_POINT],
    ['7702 で委任した EOA が自分の execute を呼んだ', () => execute(markedTransfer(BK, SHOP, BILL)), CUSTOMER, CUSTOMER],
    ['7702 で委任した EOA の execute を、中継の送り手が呼んだ', () => execute(markedTransfer(BK, SHOP, BILL)), BUNDLER, CUSTOMER],
  ] as const)('スマートアカウントの tx (%s): input の中に「transfer(受取先, 請求額) + 印」→ 通常決済の行', async (_name, input, txFrom, txTo) => {
    showGasless();
    pay(995n, 1, { input: input(), txFrom, txTo });
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    expect(loadHistory()[0]).toMatchObject({ payMode: 'standard', gasMode: null, customer: getAddress(CUSTOMER) });
  });

  it('レジ (/checkout) のガスレスの QR: 明細の合計 − 値引き の額の Transfer + 印 → 明細・商品名・管理番号つきの通常決済の行', async () => {
    const url = buildCheckoutUrl(ORIGIN, {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'merchant', mode: 'gasless', receiptNo: 'R-0012', discount: '80',
      items: [{ name: 'コーヒー', qty: 2, price: '500' }, { name: 'ケーキ', qty: 1, price: '480' }],
    });
    showQrBill({ billKey: BK, kind: 'checkout', url, itemName: '' }, NOW);
    // 値引き前の合計 (1,480) では書かない。合計 − 値引き (1,400) で書く。
    pay(994n, 1, { value: 1_480n * ONE });
    pay(995n, 2, { value: 1_400n * ONE });
    await tick();
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0]).toMatchObject({
      id: stdId(tx(2)), productName: 'コーヒー, ケーキ', receiptNo: 'R-0012', saleAmount: (1_400n * ONE).toString(),
      merchantAmount: (1_400n * ONE).toString(), payMode: 'standard', storeName: '',
    });
    expect(loadHistory()[0].lineItems).toHaveLength(2);
  });

  it('払った側の行が先にある (同じブラウザで払った) → 書かない (印だけ付ける)・知らせない', async () => {
    appendHistory(
      buildHistoryEntry({
        flow: 'standard-merchant', status: 'success', chainId: POLYGON.chainId, chainSlug: 'polygon', asset: 'jpyc',
        tokenAddress: JPYC, payMode: 'standard', gasMode: null, merchant: SHOP, merchantAmount: BILL,
        customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 0n, saleAmount: BILL,
        networkFeeEquivalent: null, txHash: tx(1), userOpHash: null, blockNumber: 995n, errorMessage: null,
        storeName: 'payer wrote this', note: '',
      }),
    );
    hold.appends = 0;
    const listener = vi.fn();
    showGasless(BK, {}, NOW, listener);
    pay(995n, 1);
    await tick();
    expect(hold.appends).toBe(0);
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0].storeName).toBe('payer wrote this');
    expect(marks()).toEqual([tx(1)]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('印・額・受取先・時刻・送り手がそろわなければ書かない (額だけの一致では書かない)', () => {
  it.each([
    ['回収の後の着金額 (Settled の期待値) の Transfer + 印', { value: NET }, false],
    ['請求額ちょうど・印なし (印を付けない払う側の transfer そのまま)', { input: plainTransfer(SHOP, BILL) }, true],
    ['請求額ちょうど・別の会計の bill key の印', { billKey: BK2 }, true],
    ['1 wei 少ない額 + 印', { value: BILL - 1n }, false],
    ['1 wei 多い額 + 印', { value: BILL + 1n }, false],
    ['送り手が forwarder (請求額ちょうど・input は印つき)', { from: FORWARDER, txFrom: CUSTOMER }, false],
    ['別の受取先宛て (RPC が絞らずに返した)', { to: OTHER_SHOP }, false],
    ['EOA が直接送った tx の送り手が、Transfer の from と違う', { txFrom: OTHER_CUSTOMER }, true],
    ['EOA が直接送った tx の input の後ろに余計な byte', { input: `${markedTransfer(BK, SHOP, BILL)}00` as Hex }, true],
    [
      'スマートアカウントの tx で、印が、額の違う transfer (回収の後の着金額) の後ろにある',
      { input: handleOps(execute(markedTransfer(BK, SHOP, NET))), txFrom: BUNDLER, txTo: ENTRY_POINT },
      true,
    ],
    [
      'Transfer が 1 つの tx の input に transfer が 2 つ (印つき + 印なし)',
      {
        input: handleOps(executeBatch([markedTransfer(BK, SHOP, BILL), plainTransfer(SHOP, BILL)])),
        txFrom: BUNDLER, txTo: ENTRY_POINT,
      },
      true,
    ],
  ] as const)('%s → 行にしない', async (_name, over, readsTx) => {
    const listener = vi.fn();
    showGasless(BK, {}, NOW, listener);
    pay(995n, 1, over);
    // 受取先の topic で絞らない RPC (別の受取先宛ても返す)。
    rpc.switched.mockImplementation(async () => chain.transfers);
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
    expect(hold.appends).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    // 額・受取先・送り手が会計と違う Transfer は、block の時刻も tx も読まない。
    expect(rpc.tx).toHaveBeenCalledTimes(readsTx ? 1 : 0);
    expect(rpc.time).toHaveBeenCalledTimes(readsTx ? 1 : 0);
    // 読んだ log は、重ねて読んでも tx を読み直さない。会計の 1 件目も消費していない (次の正しい入金が明細つき)。
    await tick(2);
    expect(rpc.tx).toHaveBeenCalledTimes(readsTx ? 1 : 0);
    chain.head = 1_004n;
    pay(1_000n, 2);
    await tick();
    expect(rows()).toEqual([[stdId(tx(2)), 'G-1']]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ billKey: BK, count: 1, amount: BILL.toString() });
  });

  it.each([
    ['着金 = 請求額・利用料 0', BILL, 0n],
    ['着金 = 請求額・利用料 = 回収の額', BILL, FEE],
  ] as const)('通常決済の額の Settled (%s・この bill key の署名つき) → 行にしない (block の時刻も読まない)', async (_name, merchantValue, feeValue) => {
    showGasless();
    settle(995n, 1, { merchantValue, feeValue });
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(rpc.time).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
  });

  it('block の時刻が、会計の生きていた間 (表示を始めてから、やめて 60 秒まで・時計のずれ 30 秒) の外なら書かない (tx も読まない)', async () => {
    showGasless(BK, {}, NOW);
    hideQrBill(BK, NOW);
    // 読み取りが遅れて、先頭がもう 1,050 (Settled は 1,047 まで照合し終える)。
    chain.head = 1_050n;
    rpc.switched.mockImplementation(async () => chain.transfers);
    pay(984n, 1); // NOW − 32 秒: 外
    pay(985n, 2); // NOW − 30 秒: 内 (端)
    pay(1_045n, 3); // NOW + 90 秒: 内 (端)
    pay(1_046n, 4); // NOW + 92 秒: 外
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(3)), null],
      [stdId(tx(2)), 'G-1'],
    ]);
    expect(rpc.tx.mock.calls.map(([, hash]) => hash)).toEqual([tx(2), tx(3)]);
  });

  it('表示をやめた後 60 秒は切り替えた入金も読み続け、その間の入金を行にする。60 秒を過ぎたら、どちらも読むのをやめる', async () => {
    showGasless();
    await tick();
    hideQrBill(BK, Date.now());
    // やめた後も 6 秒おきに読む (やめて 54 秒後まで 9 回)。
    chain.head = 1_020n;
    pay(1_015n, 1);
    await tick(9);
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    expect(rpc.switched).toHaveBeenCalledTimes(10);
    expect(rpc.logs).toHaveBeenCalledTimes(10);
    // やめて 60 秒ちょうどの回は読み、その次の回 (66 秒後) に会計を捨てて止まる。
    await tick(2);
    expect(vi.getTimerCount()).toBe(0);
    const reads = [rpc.head.mock.calls.length, rpc.logs.mock.calls.length, rpc.switched.mock.calls.length];
    chain.head = 1_040n;
    pay(1_036n, 2);
    await tick(5);
    expect([rpc.head.mock.calls.length, rpc.logs.mock.calls.length, rpc.switched.mock.calls.length]).toEqual(reads);
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
  });
});

describe('会計の件数・明細・1 tx 1 行・知らせは、Settled の入金と切り替えた入金で 1 つ', () => {
  it('forwarder の settle の tx (Settled + forwarder から受取先への Transfer) → ガスレスの行 1 つ・tx は読まない', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    // forwarder.settle の log の順: お客様 → forwarder・forwarder → お店・forwarder → 利用料の受取口・Settled。
    pay(995n, 1, { from: FORWARDER, value: NET, logIndex: 1, txFrom: BUNDLER, txTo: FORWARDER, input: '0x12345678' });
    settle(995n, 1, { logIndex: 3 });
    await tick();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    expect(loadHistory()[0]).toMatchObject({ payMode: 'gasless', gasMode: 'merchant', merchantAmount: NET.toString() });
    expect(rpc.tx).not.toHaveBeenCalled();
    expect(hold.appends).toBe(1);
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
  });

  it.each([
    ['チェーンの順も Settled の入金が先', 994n, 995n],
    ['チェーンの順は切り替えた入金が先', 996n, 995n],
  ] as const)(
    '同じ回に、同じ会計のガスレスの入金と切り替えた入金が別の tx で見つかる (%s) → 2 行・count 1 と 2・1 件目 (明細つき) は Settled の入金',
    async (_name, settledBlock, transferBlock) => {
      const seen: QrBillRecorded[] = [];
      showGasless(BK, {}, NOW, (e) => seen.push(e));
      settle(settledBlock, 1);
      pay(transferBlock, 2);
      await tick();
      // 切り替えた入金は、同じ回の Settled の照合・保存の後に読む。同じ回なら、チェーンの順に関わらず Settled の入金が 1 件目
      // (受け入れている限界: lib/qrSaleWatch.ts の頭の注記)。
      expect(rows()).toEqual([
        [stdId(tx(2)), null],
        [gaslessId(tx(1)), 'G-1'],
      ]);
      expect(loadHistory()[0]).toMatchObject({ payMode: 'standard', saleAmount: BILL.toString(), lineItems: null, storeName: '' });
      expect(loadHistory()[1]).toMatchObject({ payMode: 'gasless', saleAmount: BILL.toString(), merchantAmount: NET.toString() });
      expect(seen).toEqual([
        { billKey: BK, count: 1, amount: BILL.toString() },
        { billKey: BK, count: 2, amount: BILL.toString() },
      ]);
      expect(marks().sort()).toEqual([tx(1), tx(2)].sort());
    },
  );

  it('回が分かれれば、先に見つかった方が 1 件目: 切り替えた入金 (明細つき) → 次の回のガスレスの入金は 2 件目 (明細なし)', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    pay(995n, 1);
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    chain.head = 1_004n;
    settle(1_000n, 2);
    await tick();
    expect(rows()).toEqual([
      [gaslessId(tx(2)), null],
      [stdId(tx(1)), 'G-1'],
    ]);
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
  });

  it.each([
    ['log の番号は Settled が先', 0, 1],
    ['log の番号は Transfer が先', 1, 0],
  ] as const)(
    '1 つの tx を、同じ会計の Settled と印の付いた Transfer の両方が拾う (%s) → ガスレスの行 1 つ・知らせ 1 回・件数は 1 つだけ進む・tx は読まない',
    async (_name, settledIndex, transferIndex) => {
      const seen: QrBillRecorded[] = [];
      showGasless(BK, {}, NOW, (e) => seen.push(e));
      settle(995n, 1, { logIndex: settledIndex });
      pay(995n, 1, { logIndex: transferIndex, input: wrapped(), txFrom: BUNDLER, txTo: ENTRY_POINT });
      await tick();
      // 行はガスレスの行 (着金額・利用料は Settled の値)。通常決済の行に変わらない。
      expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
      expect(loadHistory()[0]).toMatchObject({
        payMode: 'gasless', gasMode: 'merchant', merchantAmount: NET.toString(), networkFeeEquivalent: FEE.toString(),
      });
      expect(marks()).toEqual([tx(1)]);
      expect(hold.appends).toBe(1);
      expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
      expect(rpc.tx).not.toHaveBeenCalled();
      // 次の別の tx の入金は 2 件目 (同じ tx を 2 つの経路で二重に数えていない)。
      chain.head = 1_004n;
      pay(1_000n, 2);
      await tick();
      expect(seen.map((e) => e.count)).toEqual([1, 2]);
      expect(loadHistory()[0]).toMatchObject({ id: stdId(tx(2)), receiptNo: null, lineItems: null });
    },
  );

  it('Settled の getLogs を読めなかった回は、切り替えた入金を読まない。両方が一致する tx は、Settled を読めた回にガスレスの行になる (Transfer では数えない)', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    settle(995n, 1, { logIndex: 1 });
    pay(995n, 1, { logIndex: 0, input: wrapped(), txFrom: BUNDLER, txTo: ENTRY_POINT });
    rpc.logs.mockImplementationOnce(async () => {
      throw down();
    });
    await tick();
    expect(rpc.switched).not.toHaveBeenCalled();
    expect(loadHistory()).toEqual([]);
    expect(rpc.time).not.toHaveBeenCalled();
    await tick();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    expect(loadHistory()[0]).toMatchObject({
      payMode: 'gasless', merchantAmount: NET.toString(), networkFeeEquivalent: FEE.toString(),
    });
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
    expect(rpc.tx).not.toHaveBeenCalled();
    expect(hold.appends).toBe(1);
  });

  it('RPC がその block の Settled を欠いて返した回に、切り替えた入金が先に数えた tx: 後から届いた Settled は件数を増やさない (次の別の入金は 2 件目)。行は tx ごとに 1 つ', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    settle(995n, 1, { logIndex: 0 });
    pay(995n, 1, { logIndex: 1, input: wrapped(), txFrom: BUNDLER, txTo: ENTRY_POINT });
    // 1 回目の Settled の getLogs は成功するが、995 の Settled が入っていない (古い node)。
    rpc.logs.mockImplementationOnce(async () => []);
    await tick();
    // 受け入れている限界: この tx は、切り替えた入金の行 (通常決済の行) になる。
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
    // 次の回に、重ねて読んだ範囲で Settled が届く: 件数は増やさない・行も知らせも足さない (その tx の印がある)。
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(2);
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    expect(hold.appends).toBe(1);
    expect(seen).toHaveLength(1);
    chain.head = 1_004n;
    pay(1_000n, 2);
    await tick();
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
    expect(loadHistory()[0]).toMatchObject({ id: stdId(tx(2)), receiptNo: null, lineItems: null });
  });

  it('切り替えた入金が先に数えたが印を書けなかった tx (1 回だけの失敗) に、後から Settled が届く: 件数を増やさずに (1 件目・明細つき) ガスレスの行を書く', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    settle(995n, 1, { logIndex: 0 });
    pay(995n, 1, { logIndex: 1, input: wrapped(), txFrom: BUNDLER, txTo: ENTRY_POINT });
    rpc.logs.mockImplementationOnce(async () => []);
    const marksWrite = failMarkWriteOnce();
    await tick();
    expect(marksWrite.state.failed).toBe(true);
    expect(rows()).toEqual([]);
    expect(seen).toEqual([]);
    // 次の回に Settled が届く。保存は今までどおり試み、今度は書ける。
    await tick();
    marksWrite.restore();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    expect(loadHistory()[0]).toMatchObject({ payMode: 'gasless', merchantAmount: NET.toString() });
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
    chain.head = 1_004n;
    pay(1_000n, 2);
    await tick();
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
  });

  it('両方が一致する tx で、Settled の行の印を書けなかった (1 回だけの失敗) → Settled だけの tx と同じ結果 (行なし・知らせなし)。同じ tx の Transfer で通常決済の行に変えず、件数も 1 つだけ', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    settle(995n, 1, { logIndex: 0 });
    pay(995n, 1, { logIndex: 1, input: wrapped(), txFrom: BUNDLER, txTo: ENTRY_POINT });
    const marksWrite = failMarkWriteOnce();
    await tick();
    marksWrite.restore();
    expect(marksWrite.state.failed).toBe(true);
    expect(rows()).toEqual([]);
    expect(hold.appends).toBe(0);
    expect(seen).toEqual([]);
    expect(rpc.tx).not.toHaveBeenCalled();
    // 重ねて読んでも、同じ tx の Transfer が後から通常決済の行を書くことは無い。
    await tick(2);
    expect(rows()).toEqual([]);
    // 件数は Settled の 1 回だけ: 次の別の tx の入金は 2 件目。
    chain.head = 1_008n;
    pay(1_004n, 2);
    await tick();
    expect(rows()).toEqual([[stdId(tx(2)), null]]);
    expect(seen).toEqual([{ billKey: BK, count: 2, amount: BILL.toString() }]);
  });

  it('両方が一致する tx で、Settled の行を履歴に書けなかった (notSaved): 印は残り、同じ tx の Transfer で書き直さない (通常決済の行にもしない)', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    settle(995n, 1, { logIndex: 0 });
    pay(995n, 1, { logIndex: 1, input: wrapped(), txFrom: BUNDLER, txTo: ENTRY_POINT });
    const restore = failHistoryWrite();
    await tick();
    restore();
    expect(rows()).toEqual([]);
    expect(marks()).toEqual([tx(1)]);
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString(), notSaved: true }]);
    // storage が戻った後に重ねて読んでも、Settled でも Transfer でも書き直さない。
    await tick(2);
    expect(rows()).toEqual([]);
    expect(hold.appends).toBe(1);
    expect(seen).toHaveLength(1);
    expect(rpc.tx).not.toHaveBeenCalled();
  });

  it('1 つの tx に、同じ会計の印の付いた Transfer が 2 つ: 切り替えた入金として数えるのは 1 回 (1 つの tx を同じ会計に数えるのは 1 回)', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    const input = handleOps(executeBatch([markedTransfer(BK, SHOP, BILL), markedTransfer(BK, SHOP, BILL)]));
    pay(995n, 1, { logIndex: 0, input, txFrom: BUNDLER, txTo: ENTRY_POINT });
    pay(995n, 1, { logIndex: 1, input, txFrom: BUNDLER, txTo: ENTRY_POINT });
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
    chain.head = 1_004n;
    pay(1_000n, 2);
    await tick();
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
  });

  it('通常決済の QR とガスレスの QR が、同じ受取先・同じ額で同時にある: 入金は input にある印の会計の行になり、件数は会計ごと (同じ範囲を種類ごとに 1 回ずつ読む)', async () => {
    const gasless: QrBillRecorded[] = [];
    const std: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => gasless.push(e));
    showStd(BK2, {}, NOW, (e) => std.push(e));
    pay(993n, 1, { billKey: BK2 });
    pay(994n, 2, { billKey: BK });
    settle(995n, 3, { billKey: BK });
    // 通常決済の QR の bill key で署名した Settled は、どの会計の入金にもならない (通常決済の QR の会計は Settled を読まない)。
    settle(996n, 4, { billKey: BK2 });
    await tick();
    expect(settledRanges()).toEqual([[910n, 997n]]);
    expect(transferRanges()).toEqual([[910n, 997n]]);
    expect(switchedRanges()).toEqual([[910n, 997n]]);
    // 今までの回 (通常決済の会計の 993・ガスレスの会計の Settled 995) が先。切り替えた入金 (994) は同じ回の最後 = 2 件目。
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [gaslessId(tx(3)), 'G-1'],
      [stdId(tx(1)), 'S-1'],
    ]);
    expect(gasless).toEqual([
      { billKey: BK, count: 1, amount: BILL.toString() },
      { billKey: BK, count: 2, amount: BILL.toString() },
    ]);
    expect(std).toEqual([{ billKey: BK2, count: 1, amount: BILL.toString() }]);
    // 同じ tx は、2 つの種類が照合しても 1 回だけ読む。
    expect(rpc.tx.mock.calls.map(([, hash]) => hash)).toEqual([tx(1), tx(2)]);
  });

  it('切り替えた入金の行を履歴に書けなかった (黙った失敗) → notSaved つきで知らせる。印は残り、書き直さない。次の Settled の入金は 2 件目', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    pay(995n, 1);
    const restore = failHistoryWrite();
    await tick();
    restore();
    expect(rows()).toEqual([]);
    expect(marks()).toEqual([tx(1)]);
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString(), notSaved: true }]);
    chain.head = 1_004n;
    settle(1_000n, 2);
    await tick();
    expect(rows()).toEqual([[gaslessId(tx(2)), null]]);
    expect(hold.appends).toBe(2);
    expect(seen[1]).toEqual({ billKey: BK, count: 2, amount: BILL.toString() });
    // 見張りの警告は固定のイベント名だけ (tx・bill key を出さない)。
    expect(warn.mock.calls.filter(([event]) => String(event).startsWith('qrSale.'))).toEqual([
      ['qrSale.row_not_confirmed', {}],
    ]);
  });
});

describe('切り替えた入金の段の失敗・上限・順: ほかの種類へ波及させない', () => {
  it('切り替えた入金の getLogs だけ失敗 → Settled は読んで進める (位置も今までどおり)。次の回の Settled の範囲 (重ね) に入っている入金は、次の回に拾う。入っていない入金は行にならない (限界)', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    // 980 は、次の回の Settled の範囲 (987〜) より前。994 は範囲の中。
    pay(980n, 3);
    pay(994n, 1);
    settle(995n, 2);
    rpc.switched.mockImplementationOnce(async () => {
      throw down();
    });
    await tick();
    expect(rows()).toEqual([[gaslessId(tx(2)), 'G-1']]);
    chain.head = 1_004n;
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(1)), null],
      [gaslessId(tx(2)), 'G-1'],
    ]);
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
    // 切り替えた入金は位置を持たない: 次の回も、その回の Settled と同じ範囲だけ。Settled の位置は、切り替えた入金の失敗で変わらない。
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(switchedRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(warn).not.toHaveBeenCalled();
    await tick(3);
    expect(loadHistory()).toHaveLength(2);
  });

  it('Settled の getLogs だけ失敗 → その回は切り替えた入金を読まない。同じ回の通常決済の QR の会計は、切り替えた入金より後ろの block の入金でも、今までどおり書く', async () => {
    showGasless();
    showStd(BK2, { to: OTHER_SHOP });
    settle(994n, 1);
    // ガスレスの会計の切り替えた入金 (993) が、通常決済の QR の会計 (別の受取先) の入金 (996) より前にある。
    pay(993n, 2);
    pay(996n, 3, { billKey: BK2, to: OTHER_SHOP });
    rpc.logs.mockImplementationOnce(async () => {
      throw down();
    });
    await tick();
    expect(rows()).toEqual([[stdId(tx(3)), 'S-1']]);
    expect(rpc.tx.mock.calls.map(([, hash]) => hash)).toEqual([tx(3)]);
    expect(rpc.switched).not.toHaveBeenCalled();
    chain.head = 1_004n;
    await tick();
    // Settled (994) が 1 件目。切り替えた入金 (993) は、Settled を読めた回に 2 件目として書く。
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [gaslessId(tx(1)), 'G-1'],
      [stdId(tx(3)), 'S-1'],
    ]);
    expect(settledRanges()).toEqual([[910n, 997n], [914n, 1_001n]]);
    // 切り替えた入金が読むのは、Settled を読めた回の、Settled と同じ範囲だけ。
    expect(switchedRanges()).toEqual([[914n, 1_001n]]);
    // 通常決済の会計の位置は、今までどおり (前回の続き − 10 から)。
    expect(transferRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Settled を途中で次の回に回した回 (block の時刻を読めない): 切り替えた入金が読むのは、Settled が照合し終えた所まで。その後ろは、Settled を照合し終えた回に読む', async () => {
    showGasless();
    pay(992n, 2);
    settle(994n, 1);
    pay(995n, 3);
    let failed = false;
    rpc.time.mockImplementation(async (_chainId: number, block: bigint) => {
      if (block === 994n && !failed) {
        failed = true;
        throw new Error('rpc down');
      }
      return blockTime(block);
    });
    await tick();
    // Settled は 993 まで照合し終えた。992 の切り替えた入金は書く (1 件目)。995 は範囲の外 (読まない・tx も読まない)。
    expect(rows()).toEqual([[stdId(tx(2)), 'G-1']]);
    expect(rpc.tx.mock.calls.map(([, hash]) => hash)).toEqual([tx(2)]);
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(3)), null],
      [gaslessId(tx(1)), null],
      [stdId(tx(2)), 'G-1'],
    ]);
    // 切り替えた入金の範囲は、その回の Settled が照合し終えた範囲と同じ (始まりも終わりも)。
    expect(switchedRanges()).toEqual([[910n, 993n], [983n, 997n]]);
  });

  it('先頭を待つ間に、通常決済の QR の受取先のガスレスの会計が加わった: その回は、その受取先の切り替えた入金を照合しない。次の回に Settled が先に数えて、両方が一致する tx はガスレスの行', async () => {
    showGasless(BK);
    showStd(BK2, { to: OTHER_SHOP, amount: '500' });
    // 別の受取先のガスレスの会計 (BK3) への、Settled と Transfer の両方が一致する tx。
    settle(995n, 1, { billKey: BK3, merchant: OTHER_SHOP, logIndex: 1 });
    pay(995n, 1, {
      billKey: BK3, to: OTHER_SHOP, logIndex: 0, input: wrapped(BK3, OTHER_SHOP), txFrom: BUNDLER, txTo: ENTRY_POINT,
    });
    // 先頭の応答を待つ間に、その受取先のガスレスの会計が加わる (この回の Settled の getLogs は SHOP だけを読む)。
    rpc.head.mockImplementationOnce(async () => {
      showGasless(BK3, { to: OTHER_SHOP, receiptNo: 'G-3' }, NOW - 60_000);
      return chain.head;
    });
    await tick();
    expect(rpc.logs.mock.calls.map(([, , merchants]) => merchants)).toEqual([[getAddress(SHOP)]]);
    expect(rpc.switched.mock.calls.map(([, , merchants]) => merchants)).toEqual([[getAddress(SHOP)]]);
    expect(loadHistory()).toEqual([]);
    expect(rpc.tx).not.toHaveBeenCalled();
    await tick();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-3']]);
    expect(loadHistory()[0]).toMatchObject({ payMode: 'gasless', merchant: getAddress(OTHER_SHOP), merchantAmount: NET.toString() });
    expect(rpc.tx).not.toHaveBeenCalled();
  });

  it('先頭を待つ間に、同じ受取先のガスレスの会計が加わった: その回は候補にしない (会計は回の始まりの写し)。次の回から照合する', async () => {
    showGasless(BK);
    // 後から加わる会計 (BK2) の印の付いた入金が、もうチェーンにある (BK とは同じ受取先・同じ額)。
    pay(995n, 1, { billKey: BK2 });
    rpc.head.mockImplementationOnce(async () => {
      showGasless(BK2, { receiptNo: 'G-2' }, NOW - 60_000);
      return chain.head;
    });
    await tick();
    expect(rpc.switched).toHaveBeenCalledTimes(1);
    expect(loadHistory()).toEqual([]);
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'G-2']]);
  });

  it.each([
    ['tx を読めない', () => rpc.tx.mockImplementationOnce(() => Promise.reject(new Error('rpc down')))],
    [
      'block の時刻 (993) を読めない',
      () => {
        let failed = false;
        rpc.time.mockImplementation(async (_chainId: number, block: bigint) => {
          if (block === 993n && !failed) {
            failed = true;
            throw new Error('rpc down');
          }
          return blockTime(block);
        });
      },
    ],
  ])('%s Transfer で、その回の切り替えた入金をやめる (後ろも照合しない)。同じ回の Settled の入金は、もう書いてある。次の回の Settled の範囲に入っていれば読み直す', async (_name, breakOnce) => {
    showGasless();
    pay(993n, 1);
    pay(994n, 2);
    settle(996n, 3);
    breakOnce();
    await tick();
    expect(rows()).toEqual([[gaslessId(tx(3)), 'G-1']]);
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [stdId(tx(1)), null],
      [gaslessId(tx(3)), 'G-1'],
    ]);
    // Settled は 997 の続き − 10 から (今までどおり)。切り替えた入金も同じ範囲。
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 997n]]);
    expect(switchedRanges()).toEqual([[910n, 997n], [987n, 997n]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('1 回 (チェーンごと) に読む tx は 4 つまで。超えたら、その回の切り替えた入金をやめる (次の回の Settled の範囲に入っていれば読み直す・読めた tx は読み直さない)', async () => {
    expect(QR_SALE_MAX_TX_READS_PER_PASS).toBe(4);
    showGasless();
    // 請求額と同じ額の関係ない入金 (印なし) 5 つの後に、この会計の切り替えた入金。
    for (let i = 1; i <= 5; i += 1) pay(BigInt(989 + i), i, { input: plainTransfer(SHOP, BILL) });
    pay(996n, 6);
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(4);
    expect(loadHistory()).toEqual([]);
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(6);
    expect(rows()).toEqual([[stdId(tx(6)), 'G-1']]);
    expect(switchedRanges()).toEqual([[910n, 997n], [987n, 997n]]);
  });

  it('tx を待っている間に /create を離れたら (stop)、後から返っても行を書かない', async () => {
    let release!: (value: QrSaleTx) => void;
    showGasless();
    pay(995n, 1);
    rpc.tx.mockImplementationOnce(() => new Promise<QrSaleTx>((resolve) => { release = resolve; }));
    await tick();
    stopQrSaleWatch();
    release(chain.txs.get(tx(1))!);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
  });
});

describe('回は 1 つずつ (並行に走らせない): 全チェーンの Settled の記録は切り替えた入金を待たず、進行中の回の会計は消されない', () => {
  it('あるチェーンの切り替えた入金の getLogs が返らなくても、同じ回の、後ろのチェーンの Settled の行と知らせは確定している。その間に /create を離れても残る', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK);
    showGasless(BK2, { chain: 'kaia', receiptNo: 'K-1' }, NOW, (e) => seen.push(e));
    settle(995n, 1, { billKey: BK2, chainId: KAIA.chainId, merchantValue: BILL - KAIA_FEE, feeValue: KAIA_FEE });
    // Polygon (先に読むチェーン) の切り替えた入金だけ返らない。
    rpc.switched.mockImplementation((chainId: number) =>
      chainId === POLYGON.chainId ? never<QrSaleLog[]>() : Promise.resolve([]),
    );
    await tick();
    // 全チェーンの今までの回が先: Kaia の Settled は、Polygon の切り替えた入金を待たない。
    expect(rpc.switched.mock.calls.map(([chainId]) => chainId)).toEqual([POLYGON.chainId]);
    expect(rows()).toEqual([[gaslessId(tx(1)), 'K-1']]);
    expect(loadHistory()[0].chainId).toBe(KAIA.chainId);
    expect(seen).toEqual([{ billKey: BK2, count: 1, amount: BILL.toString() }]);
    stopQrSaleWatch();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'K-1']]);
    // 返らない読み取りは 7 秒で切れて、回が終わる (次のテストへ持ち越さない)。
    await vi.advanceTimersByTimeAsync(8_000);
  });

  it('切り替えた入金の getLogs が返らなくても、同じ回の Settled の行と知らせは確定している。その間に /create を離れても残る', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    settle(995n, 1);
    rpc.switched.mockImplementation(() => never<QrSaleLog[]>());
    await tick();
    expect(rpc.switched).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
    stopQrSaleWatch();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    expect(marks()).toEqual([tx(1)]);
    // 返らない読み取りは 7 秒で切れて、回が終わる (次のテストへ持ち越さない)。
    await vi.advanceTimersByTimeAsync(8_000);
  });

  it('切り替えた入金の tx の読み取りを待たない: tx が返る前に、同じ回の Settled の入金が確定し、返った後の切り替えた入金は 2 件目', async () => {
    let release!: (value: QrSaleTx) => void;
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    pay(994n, 2);
    settle(995n, 1);
    rpc.tx.mockImplementationOnce(() => new Promise<QrSaleTx>((resolve) => { release = resolve; }));
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
    release(chain.txs.get(tx(2))!);
    await vi.advanceTimersByTimeAsync(0);
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [gaslessId(tx(1)), 'G-1'],
    ]);
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
  });

  it.each([
    ['ガスレスの QR の切り替えた入金', (billKey: string) => showGasless(billKey), 'G-1'],
    ['通常決済の QR の入金', (billKey: string) => showStd(billKey), 'S-1'],
  ] as const)(
    '%s: 表示をやめて 60 秒の間に読み始めた回が、tx の応答を待つ間に 60 秒を過ぎても、会計は消されず、期間内の入金を書く',
    async (_name, show, receiptNo) => {
      let release!: (value: QrSaleTx) => void;
      show(BK);
      await tick();
      hideQrBill(BK, Date.now());
      // やめて 54 秒後まで読む。
      await tick(9);
      // やめて 50 秒後 (期間内) の block の入金。やめて 60 秒ちょうどの回が読み始め、tx の応答を待つ。
      chain.head = 1_032n;
      pay(1_028n, 1);
      rpc.tx.mockImplementationOnce(() => new Promise<QrSaleTx>((resolve) => { release = resolve; }));
      await tick();
      expect(rpc.tx).toHaveBeenCalledTimes(1);
      expect(loadHistory()).toEqual([]);
      // 次の回の時刻 (やめて 66 秒後) が来ても、進行中の回があるので会計を消さない。
      await tick();
      release(chain.txs.get(tx(1))!);
      await vi.advanceTimersByTimeAsync(0);
      expect(rows()).toEqual([[stdId(tx(1)), receiptNo]]);
      // その次の回に、会計を捨てて止まる。
      await tick();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('切り替えた入金の getLogs が返らない回は 7 秒で切れる。その間は次の回を重ねず (今までの「返らない RPC」と同じ)、切れた後の回からまた読む', async () => {
    showGasless();
    rpc.switched.mockImplementationOnce(() => never<QrSaleLog[]>());
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    // 6 秒後: 前の回がまだ待っているので、重ねない。
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    // 7 秒で切れた後の回: Settled も切り替えた入金も読む (切り替えた入金は、その回の Settled と同じ範囲)。
    chain.head = 1_008n;
    settle(1_003n, 1);
    pay(1_004n, 2);
    await tick();
    expect(rpc.logs).toHaveBeenCalledTimes(2);
    expect(switchedRanges()).toEqual([[910n, 997n], [987n, 1_005n]]);
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [gaslessId(tx(1)), 'G-1'],
    ]);
  });
});

describe('切り替えた入金が読むのは、その回の Settled が読んだ範囲だけ・失敗は共有の状態を変えない', () => {
  it('間が空いた後 (タブが裏 → 先頭 1,120): Settled が読み飛ばした範囲 (998〜1,029) は、切り替えた入金も読まない。そこにある、両方が一致する tx を通常決済の行にしない', async () => {
    showGasless();
    await tick();
    // Settled は 997 まで照合し終えた。タブが裏の間に、1,010 に Settled と Transfer の両方が一致する tx。
    settle(1_010n, 1, { logIndex: 0 });
    pay(1_010n, 1, { logIndex: 1, input: wrapped(), txFrom: BUNDLER, txTo: ENTRY_POINT });
    hold.visibility = 'hidden';
    await tick(3);
    hold.visibility = 'visible';
    chain.head = 1_120n;
    await tick();
    // Settled は先頭 − 90 (1,030) から (今までどおり)。切り替えた入金も同じ範囲だけ。
    expect(settledRanges()).toEqual([[910n, 997n], [1_030n, 1_117n]]);
    expect(switchedRanges()).toEqual([[910n, 997n], [1_030n, 1_117n]]);
    expect(loadHistory()).toEqual([]);
    expect(rpc.tx).not.toHaveBeenCalled();
  });

  it('RPC が範囲の外の log を返しても、その回の Settled が照合し終えた範囲の外の Transfer は照合しない', async () => {
    showGasless();
    await tick();
    chain.head = 1_004n;
    // 次の回の Settled の範囲は 987〜1,001。範囲の前 (980) と後ろ (1,003) の、印の付いた入金。
    pay(980n, 1);
    pay(1_003n, 2);
    rpc.switched.mockImplementation(async () => chain.transfers);
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(rpc.time).not.toHaveBeenCalled();
    // 1,003 は、Settled がそこまで照合し終えた回に書く。
    chain.head = 1_008n;
    await tick();
    expect(rows()).toEqual([[stdId(tx(2)), 'G-1']]);
  });

  it('切り替えた入金の getLogs だけが「結果が多すぎる」を返す: その回だけ 10 block ずつ読み直して拾う。10 block ずつ読むチェーンの覚えには入れない (Settled と通常決済の会計は、次の回も 1 回で読む)', async () => {
    const tooMany = () =>
      new HttpRequestError({
        url: 'https://rpc.test',
        status: 200,
        details: JSON.stringify({ code: -32005, message: 'query returned more than 10000 results' }),
      });
    rpc.switched.mockImplementation(async (...args: [number, Address, Address[], bigint, bigint]) => {
      const [, , , from, to] = args;
      if (to - from + 1n > QR_SALE_SMALL_RANGE_BLOCKS) throw tooMany();
      return transfersIn(...args);
    });
    showGasless(BK3);
    showStd(BK, { to: OTHER_SHOP });
    pay(995n, 1, { billKey: BK3 });
    await tick();
    // 1 回目: Settled 1 回・通常決済の会計 1 回・切り替えた入金は 1 回失敗 → 残りの枠 (7 回) で、新しい block から 10 block ずつ。
    expect(switchedRanges()).toEqual([
      [910n, 997n],
      [988n, 997n], [978n, 987n], [968n, 977n], [958n, 967n], [948n, 957n], [938n, 947n], [928n, 937n],
    ]);
    expect(rpc.logs.mock.calls.length + rpc.transfers.mock.calls.length + rpc.switched.mock.calls.length).toBe(
      QR_SALE_MAX_GETLOGS_PER_PASS,
    );
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    // 2 回目: Settled と通常決済の会計は、今までどおり 1 回で読む (範囲の制限を覚えていない)。
    chain.head = 1_004n;
    await tick();
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(transferRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
  });

  it('先のチェーンの RPC を待つ間に、後ろのチェーンに加わった会計は、その回 (tick) は候補にしない (会計は回の始まりの写し)。次の回から照合する', async () => {
    showGasless(BK);
    showGasless(BK2, { chain: 'kaia', receiptNo: 'K-1' });
    // 後から加わる Kaia の会計 (BK3) の印の付いた入金が、もうチェーンにある。
    pay(995n, 1, { billKey: BK3, token: KAIA.address });
    // Polygon (先に読むチェーン) の先頭を待つ間に、Kaia に会計が加わる。Kaia の回は、加わった後に始まる。
    rpc.head.mockImplementationOnce(async () => {
      showGasless(BK3, { chain: 'kaia', receiptNo: 'G-3' }, NOW - 60_000);
      return chain.head;
    });
    await tick();
    // Kaia の Settled は、加わった会計の受取先 (同じ受取先) も読んでいる。それでも、この回は候補にしない。
    expect(rpc.switched.mock.calls.map(([chainId]) => chainId)).toEqual([POLYGON.chainId, KAIA.chainId]);
    expect(loadHistory()).toEqual([]);
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'G-3']]);
    expect(loadHistory()[0].chainId).toBe(KAIA.chainId);
  });

  it('切り替えた入金の段が読んだ tx は、通常決済の会計の照合に使わせない: 通常決済の会計は、今までどおり 1 回に tx を 4 つ読んで照合する', async () => {
    showGasless(BK);
    showStd(BK2);
    // 通常決済の会計 (BK2) への入金 5 つ (ガスレスの会計 BK と同じ受取先・同じ額)。
    for (let i = 1; i <= 5; i += 1) pay(BigInt(989 + i), i, { billKey: BK2 });
    // 1 回目は、通常決済の会計の getLogs だけ失敗する。切り替えた入金の段は、同じ Transfer の tx を 4 つ読む (どれも BK の印ではない)。
    rpc.transfers.mockImplementationOnce(async () => {
      throw down();
    });
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(4);
    expect(loadHistory()).toEqual([]);
    // 2 回目: 通常決済の会計は、今までどおり tx を 4 つ読んで 4 件を書く。5 件目は次の回 (切り替えた入金の段が読んだ tx を使って、
    // 1 回の上限を越えて先へ進まない)。
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(8);
    expect(rows()).toEqual([
      [stdId(tx(4)), null],
      [stdId(tx(3)), null],
      [stdId(tx(2)), null],
      [stdId(tx(1)), 'S-1'],
    ]);
    await tick();
    expect(loadHistory()).toHaveLength(5);
  });

  it('Settled の getLogs が範囲の外 (読めた所より後ろ) の log を返し、その log で照合を回した回: 切り替えた入金の範囲の終わりは、Settled が読めた所まで', async () => {
    showGasless();
    // Settled が読むのは 997 まで。RPC が、範囲の外の 1,000 の Settled も返す。その block の時刻は読めない。
    settle(1_000n, 9);
    rpc.logs.mockImplementation(async () => chain.settled);
    rpc.time.mockImplementation(async (_chainId: number, block: bigint) => {
      if (block === 1_000n) throw new Error('rpc down');
      return blockTime(block);
    });
    // Settled が読んでいない 998 の、印の付いた入金。
    pay(998n, 1);
    await tick();
    expect(settledRanges()).toEqual([[910n, 997n]]);
    expect(switchedRanges()).toEqual([[910n, 997n]]);
    expect(loadHistory()).toEqual([]);
  });
});

describe('getLogs の範囲に制限のある RPC (10 block ずつ・Avalanche の RPC と同じ制限) のガスレスの会計', () => {
  const rangeError = () =>
    new HttpRequestError({
      url: 'https://rpc.test/v2/key',
      status: 400,
      details: JSON.stringify({
        code: -32600,
        message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.',
      }),
    });
  /** 11 block 以上の範囲は error を返す RPC (3 種類とも)。 */
  function limitedRpc() {
    for (const fn of [rpc.logs, rpc.transfers, rpc.switched]) {
      const inner = fn.getMockImplementation()!;
      fn.mockImplementation(async (...args: [number, Address, Address[], bigint, bigint]) => {
        const [, , , from, to] = args;
        if (to - from + 1n > QR_SALE_SMALL_RANGE_BLOCKS) throw rangeError();
        return inner(...args);
      });
    }
  }
  const chunks = (from: bigint, to: bigint) => {
    const out: bigint[][] = [];
    for (let start = from; start <= to; start += 10n) out.push([start, start + 9n < to ? start + 9n : to]);
    return out;
  };
  const calls = () => rpc.logs.mock.calls.length + rpc.transfers.mock.calls.length + rpc.switched.mock.calls.length;
  const clear = () => {
    rpc.logs.mockClear();
    rpc.transfers.mockClear();
    rpc.switched.mockClear();
  };
  const kaiaSettle = (block: bigint, n: number, billKey = BK) =>
    settle(block, n, { billKey, chainId: KAIA.chainId, merchantValue: BILL - KAIA_FEE, feeValue: KAIA_FEE });
  const key = (i: number) => `K${String(i).padStart(10, '0')}`;

  it('getLogs は種類を合わせて 1 回に 10 回まで。Settled が先に使い、切り替えた入金は残りで、その回の Settled と同じ範囲を新しい方から読む。普段の回は 2 回ずつ', async () => {
    expect(QR_SALE_MAX_GETLOGS_PER_PASS).toBe(10);
    limitedRpc();
    // QR を出したのは 4 分前 (先頭 − 90 の block も、会計の生きていた間)。
    showGasless(BK, { chain: 'kaia' }, NOW - 240_000);
    kaiaSettle(945n, 1);
    pay(915n, 2, { token: KAIA.address });
    pay(996n, 3, { token: KAIA.address });
    await tick();
    // 1 回目: Settled が範囲の制限を知る 1 回 + 10 block ずつ 9 回 = 10 回 (Kaia・Avalanche は先頭 − 1 まで)。切り替えた入金は
    // 枠が無くて読めない。
    expect(settledRanges()).toEqual([[910n, 999n], ...chunks(910n, 999n)]);
    expect(rpc.switched).not.toHaveBeenCalled();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    // 2 回目: Settled は 2 回 (989〜999)。切り替えた入金も同じ範囲を、新しい方から 2 回。
    clear();
    await tick();
    expect(settledRanges()).toEqual(chunks(989n, 999n));
    expect(switchedRanges()).toEqual([[990n, 999n], [989n, 989n]]);
    expect(calls()).toBe(4);
    // 996 の入金は拾う。915 の入金 (1 回目の範囲にだけあった) は、行にならない (受け入れている限界)。
    expect(rows()).toEqual([
      [stdId(tx(3)), null],
      [gaslessId(tx(1)), 'G-1'],
    ]);
    // 普段の回 (6 秒で 3 block 進んだ): どちらも 2 回ずつ。
    clear();
    chain.head = 1_003n;
    await tick();
    expect(settledRanges()).toEqual(chunks(989n, 1_002n));
    expect(switchedRanges()).toEqual([[993n, 1_002n], [989n, 992n]]);
    expect(calls()).toBe(4);
    await tick(3);
    expect(loadHistory()).toHaveLength(2);
  });

  it.each([
    ['同じ受取先', SHOP],
    ['新しい受取先', OTHER_SHOP],
  ] as const)(
    '新しいガスレスの QR (%s) を回ごとに出し続けても (Settled が毎回 9 回使う)、切り替えた入金は残りの 1 回で新しい 10 block を読み、直近の入金をその回に拾う',
    async (_name, nextShop) => {
      limitedRpc();
      // 見張っているお店の QR (SHOP)。払う側で通常決済に切り替えた入金は、この QR へ。
      showGasless(BK, { chain: 'kaia' });
      await tick();
      expect(rpc.switched).not.toHaveBeenCalled();
      for (let pass = 2; pass <= 5; pass += 1) {
        // 6 秒で 3 block 進む。新しいガスレスの QR を出す (Settled は先頭 − 90 から読み直す = 9 回)。
        chain.head += 3n;
        showGasless(key(pass), { chain: 'kaia', to: nextShop });
        // 直近 (先頭の 2 つ手前) の block に、BK の QR への切り替えた入金。
        pay(chain.head - 2n, pass, { token: KAIA.address });
        clear();
        await tick();
        expect(rpc.logs).toHaveBeenCalledTimes(9);
        // 切り替えた入金は、残りの 1 回で、Settled の範囲の新しい 10 block (先頭 − 10 〜 先頭 − 1)。古い方へは戻らない。
        expect(switchedRanges()).toEqual([[chain.head - 10n, chain.head - 1n]]);
        expect(loadHistory()).toHaveLength(pass - 1);
        expect(loadHistory()[0].id).toBe(stdId(tx(pass)));
      }
    },
  );

  it('通常決済の QR の会計も同じチェーンにある: Settled → 通常決済の会計の Transfer → 切り替えた入金の順に枠を使う (通常決済の会計の読む範囲は、今までどおり)', async () => {
    limitedRpc();
    showGasless(BK3, { chain: 'kaia' }, NOW - 240_000);
    showStd(BK, { chain: 'kaia' }, NOW - 240_000);
    // ガスレスの会計 (BK3) への切り替えた入金。通常決済の会計 (BK) と同じ受取先・同じ額。
    pay(995n, 1, { billKey: BK3, token: KAIA.address });
    await tick();
    // 1 回目: Settled が 10 回。
    expect(rpc.logs).toHaveBeenCalledTimes(10);
    expect(rpc.transfers).not.toHaveBeenCalled();
    expect(rpc.switched).not.toHaveBeenCalled();
    // 2 回目: Settled 2 回・通常決済の会計の Transfer が残りの 8 回 (今までどおり)。切り替えた入金は枠が無くて読めない。
    clear();
    await tick();
    expect(settledRanges()).toEqual(chunks(989n, 999n));
    expect(transferRanges()).toEqual(chunks(910n, 989n));
    expect(rpc.switched).not.toHaveBeenCalled();
    expect(loadHistory()).toEqual([]);
    // 3 回目: Settled 2 回・通常決済の会計 3 回 (989 − 10 から = 今までどおり)・切り替えた入金は Settled と同じ範囲を 2 回。
    clear();
    await tick();
    expect(settledRanges()).toEqual(chunks(989n, 999n));
    expect(transferRanges()).toEqual(chunks(979n, 999n));
    expect(switchedRanges()).toEqual([[990n, 999n], [989n, 989n]]);
    expect(calls()).toBe(7);
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
  });
});
