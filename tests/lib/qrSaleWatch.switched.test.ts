// lib/qrSaleWatch.ts の「ガスレスの会計の、通常決済で払われた入金」: ガスレスの QR (mode=gasless・JPYC) を、払う側の画面で
// 通常決済に切り替えて払った入金 (ガスレスで払えない ERC-4337 のウォレットなど) を、受取先に届いた JPYC の Transfer と、その tx の
// input の印 (transfer(受取先, 額) + bill key の印) で確かめて、取引履歴に通常決済の行を書く。Settled の入金と、会計の件数・
// 明細・1 tx 1 行・知らせを共有する。
// RPC の読み取り (lib/qrSaleRpc.ts) と nonce の式 (軽い差し替え) を差し替え、照合・行の組み立て・履歴と印 (localStorage) は実物。
// 時間は fake timer で進める。ガスレスの入金だけの回し方は tests/lib/qrSaleWatch.test.ts、通常決済の QR の会計は
// tests/lib/qrSaleWatch.standard.test.ts が確かめる (この file は、2 つの経路が 1 つの会計に重なる所を見る)。

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

const rpc = vi.hoisted(() => ({ head: vi.fn(), logs: vi.fn(), time: vi.fn(), transfers: vi.fn(), tx: vi.fn() }));
vi.mock('@/lib/qrSaleRpc', () => ({
  QR_SALE_RPC_TIMEOUT_MS: 6_000,
  readChainHead: rpc.head,
  readSettledLogs: rpc.logs,
  readBlockTime: rpc.time,
  readTransferLogs: rpc.transfers,
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
    billKey?: string; merchantValue?: bigint; feeValue?: bigint; logIndex?: number; txHash?: string; chainId?: number;
  } = {},
) {
  const sale = {
    from: CUSTOMER, merchant: SHOP, merchantValue: over.merchantValue ?? NET, feeValue: over.feeValue ?? FEE,
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
const tick = (times = 1) => vi.advanceTimersByTimeAsync(QR_SALE_POLL_MS * times);
const transferRanges = () => rpc.transfers.mock.calls.map(([, , , from, to]) => [from, to]);
const settledRanges = () => rpc.logs.mock.calls.map(([, , , from, to]) => [from, to]);
const rows = () => loadHistory().map((e) => [e.id, e.receiptNo]);
const marks = () =>
  (JSON.parse(window.localStorage.getItem(QR_SALE_MARKS_KEY) ?? '[]') as [string, number][]).map(([hash]) => hash);
const stdId = (hash: string) => `standard-merchant-${hash}`;
const gaslessId = (hash: string) => `batch-${hash}`;
const down = () => new HttpRequestError({ url: 'https://rpc.test', status: 503, details: 'upstream down' });

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
  rpc.transfers
    .mockReset()
    .mockImplementation(async (_chainId: number, _token: Address, merchants: Address[], from: bigint, to: bigint) =>
      chain.transfers.filter(
        (log) => inRange(log, from, to) && merchants.some((m) => topicAddress(log.topics[2]!) === getAddress(m)),
      ),
    );
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

  it('ガスレスの QR を出したら、6 秒おきに Settled → Transfer の順に、同じ範囲を 1 回ずつ読む (先頭は 1 回)', async () => {
    showGasless();
    expect(rpc.head).not.toHaveBeenCalled();
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(1);
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    expect(rpc.logs).toHaveBeenCalledWith(POLYGON.chainId, FORWARDER, [getAddress(SHOP)], 910n, 997n);
    expect(rpc.transfers).toHaveBeenCalledTimes(1);
    expect(rpc.transfers).toHaveBeenCalledWith(POLYGON.chainId, JPYC, [getAddress(SHOP)], 910n, 997n);
    expect(rpc.logs.mock.invocationCallOrder[0]).toBeLessThan(rpc.transfers.mock.invocationCallOrder[0]);
    // 受取先・額の合う log が無ければ、block の時刻も tx も読まない。
    expect(rpc.time).not.toHaveBeenCalled();
    expect(rpc.tx).not.toHaveBeenCalled();
    chain.head = 1_004n;
    await tick();
    expect(rpc.head).toHaveBeenCalledTimes(2);
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(transferRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
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
    expect(rpc.transfers).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('新しいガスレスの会計が加わったら、Settled と Transfer の両方の位置を戻す (先頭 − 90 から)。新しい通常決済の会計は Transfer だけ', async () => {
    showGasless(BK);
    await tick();
    chain.head = 1_004n;
    await tick();
    chain.head = 1_008n;
    showGasless(BK2, { to: OTHER_SHOP });
    await tick();
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n], [918n, 1_005n]]);
    expect(transferRanges()).toEqual([[910n, 997n], [987n, 1_001n], [918n, 1_005n]]);
    // 受取先は、2 つの会計を合わせて 1 回で読む。
    expect(rpc.logs.mock.calls[2][2]).toEqual([getAddress(SHOP), getAddress(OTHER_SHOP)]);
    expect(rpc.transfers.mock.calls[2][2]).toEqual([getAddress(SHOP), getAddress(OTHER_SHOP)]);
    chain.head = 1_012n;
    showStd(BK3);
    await tick();
    expect(settledRanges()[3]).toEqual([995n, 1_009n]);
    expect(transferRanges()[3]).toEqual([922n, 1_009n]);
  });

  it('通常決済の QR とガスレスの QR が同じチェーンに同時にある: Transfer の getLogs は 1 回で、両方の会計の受取先を読む', async () => {
    showGasless(BK);
    showStd(BK2, { to: OTHER_SHOP });
    await tick();
    expect(rpc.logs.mock.calls.map(([, , merchants]) => merchants)).toEqual([[getAddress(SHOP)]]);
    expect(rpc.transfers.mock.calls.map(([, token, merchants]) => [token, merchants])).toEqual([
      [JPYC, [getAddress(SHOP), getAddress(OTHER_SHOP)]],
    ]);
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
    rpc.transfers.mockImplementation(async () => chain.transfers);
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
    rpc.transfers.mockImplementation(async () => chain.transfers);
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

  it('表示をやめた後 60 秒は Transfer も読み続け、その間の入金を行にする。60 秒を過ぎたら、どちらも読むのをやめる', async () => {
    showGasless();
    await tick();
    hideQrBill(BK, Date.now());
    // やめた後も 6 秒おきに読む (やめて 54 秒後まで 9 回)。
    chain.head = 1_020n;
    pay(1_015n, 1);
    await tick(9);
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
    expect(rpc.transfers).toHaveBeenCalledTimes(10);
    expect(rpc.logs).toHaveBeenCalledTimes(10);
    // やめて 60 秒ちょうどの回は読み、その次の回 (66 秒後) に会計を捨てて止まる。
    await tick(2);
    expect(vi.getTimerCount()).toBe(0);
    const reads = [rpc.head.mock.calls.length, rpc.logs.mock.calls.length, rpc.transfers.mock.calls.length];
    chain.head = 1_040n;
    pay(1_036n, 2);
    await tick(5);
    expect([rpc.head.mock.calls.length, rpc.logs.mock.calls.length, rpc.transfers.mock.calls.length]).toEqual(reads);
    expect(rows()).toEqual([[stdId(tx(1)), 'G-1']]);
  });
});

describe('会計の件数・明細・1 tx 1 行・知らせは、Settled の入金と Transfer の入金で共有する', () => {
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
    ['Settled の入金が先', 994n, 995n, 'G-1', null],
    ['通常決済の入金が先 (到着の順を逆に)', 996n, 995n, null, 'G-1'],
  ] as const)(
    '同じ会計に、ガスレスの入金と通常決済の入金が別の tx で 2 つ (%s) → 2 行・count 1 と 2・明細は先の 1 件だけ',
    async (_name, settledBlock, transferBlock, settledReceipt, transferReceipt) => {
      const seen: QrBillRecorded[] = [];
      showGasless(BK, {}, NOW, (e) => seen.push(e));
      settle(settledBlock, 1);
      pay(transferBlock, 2);
      await tick();
      const byId = Object.fromEntries(loadHistory().map((e) => [e.id, e]));
      expect(Object.keys(byId).sort()).toEqual([gaslessId(tx(1)), stdId(tx(2))].sort());
      expect(byId[gaslessId(tx(1))]).toMatchObject({ payMode: 'gasless', receiptNo: settledReceipt, saleAmount: BILL.toString() });
      expect(byId[stdId(tx(2))]).toMatchObject({ payMode: 'standard', receiptNo: transferReceipt, saleAmount: BILL.toString() });
      // 明細の無い方は、明細・商品名も無い (同じ会計への 2 件目の入金)。
      const second = settledReceipt === null ? byId[gaslessId(tx(1))] : byId[stdId(tx(2))];
      expect(second).toMatchObject({ lineItems: null, storeName: '' });
      expect(seen).toEqual([
        { billKey: BK, count: 1, amount: BILL.toString() },
        { billKey: BK, count: 2, amount: BILL.toString() },
      ]);
      expect(marks().sort()).toEqual([tx(1), tx(2)].sort());
    },
  );

  it('同じ block の中では、種類をまたいで log の番号の小さい方が 1 件目 (RPC が新しい順に返しても)', async () => {
    showGasless();
    settle(995n, 1, { logIndex: 9 });
    pay(995n, 2, { logIndex: 4 });
    rpc.transfers.mockImplementation(async () => [...chain.transfers].reverse());
    await tick();
    expect(rows().sort()).toEqual([[gaslessId(tx(1)), null], [stdId(tx(2)), 'G-1']].sort());
  });

  it.each([
    ['Settled が先', 0, 1, gaslessId(tx(1)), 0],
    ['Transfer が先', 1, 0, stdId(tx(1)), 1],
  ] as const)(
    '1 つの tx を、同じ会計の Settled と印の付いた Transfer の両方が拾う (%s) → 1 行・知らせ 1 回・件数は 1 つだけ進む',
    async (_name, settledIndex, transferIndex, id, txReads) => {
      const seen: QrBillRecorded[] = [];
      showGasless(BK, {}, NOW, (e) => seen.push(e));
      settle(995n, 1, { logIndex: settledIndex });
      pay(995n, 1, {
        logIndex: transferIndex, input: handleOps(execute(markedTransfer(BK, SHOP, BILL))), txFrom: BUNDLER, txTo: ENTRY_POINT,
      });
      await tick();
      expect(rows()).toEqual([[id, 'G-1']]);
      expect(marks()).toEqual([tx(1)]);
      expect(hold.appends).toBe(1);
      expect(seen).toEqual([{ billKey: BK, count: 1, amount: BILL.toString() }]);
      // Settled で数えた tx の Transfer は、tx を読まない。
      expect(rpc.tx).toHaveBeenCalledTimes(txReads);
      // 次の別の tx の入金は 2 件目 (同じ tx を 2 つの経路で二重に数えていない)。
      chain.head = 1_004n;
      pay(1_000n, 2);
      await tick();
      expect(seen.map((e) => e.count)).toEqual([1, 2]);
      expect(loadHistory()[0]).toMatchObject({ id: stdId(tx(2)), receiptNo: null, lineItems: null });
    },
  );

  it('通常決済の QR とガスレスの QR が、同じ受取先・同じ額で同時にある: 入金は input にある印の会計の行になり、件数は会計ごと', async () => {
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
    expect(rpc.logs).toHaveBeenCalledTimes(1);
    expect(rpc.transfers).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([
      [gaslessId(tx(3)), null],
      [stdId(tx(2)), 'G-1'],
      [stdId(tx(1)), 'S-1'],
    ]);
    expect(gasless).toEqual([
      { billKey: BK, count: 1, amount: BILL.toString() },
      { billKey: BK, count: 2, amount: BILL.toString() },
    ]);
    expect(std).toEqual([{ billKey: BK2, count: 1, amount: BILL.toString() }]);
  });

  it('切り替えた入金の行を履歴に書けなかった (黙った失敗) → notSaved つきで知らせる。印は残り、書き直さない。次の Settled の入金は 2 件目', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    pay(995n, 1);
    const real = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === HISTORY_STORAGE_KEY) throw new Error('QuotaExceededError');
      real.call(this, key, value);
    });
    await tick();
    setItem.mockRestore();
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

describe('読み取りの失敗・上限: 片方の種類の失敗を、もう片方へ波及させない', () => {
  it('Transfer の getLogs だけ失敗 → Settled は読んで進める。Transfer は位置を変えず、次の回に同じ所から読む', async () => {
    const seen: QrBillRecorded[] = [];
    showGasless(BK, {}, NOW, (e) => seen.push(e));
    pay(994n, 1);
    settle(995n, 2);
    rpc.transfers.mockImplementationOnce(async () => {
      throw down();
    });
    await tick();
    expect(rows()).toEqual([[gaslessId(tx(2)), 'G-1']]);
    chain.head = 1_004n;
    await tick();
    // 受け入れている限界: 古い入金 (994) が後から見つかったので、明細は先に見つかった方 (995 の Settled) に付いたまま。
    expect(rows()).toEqual([
      [stdId(tx(1)), null],
      [gaslessId(tx(2)), 'G-1'],
    ]);
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
    // Transfer は 1 度も読めていなかった = 次の回も先頭 − 90 から。Settled は前回の続き − 10 から。
    expect(transferRanges()).toEqual([[910n, 997n], [914n, 1_001n]]);
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Settled の getLogs だけ失敗 → Transfer は読んで進める。Settled は次の回に同じ所から読む', async () => {
    showGasless();
    settle(994n, 1);
    pay(995n, 2);
    rpc.logs.mockImplementationOnce(async () => {
      throw down();
    });
    await tick();
    expect(rows()).toEqual([[stdId(tx(2)), 'G-1']]);
    chain.head = 1_004n;
    await tick();
    expect(rows()).toEqual([
      [gaslessId(tx(1)), null],
      [stdId(tx(2)), 'G-1'],
    ]);
    expect(settledRanges()).toEqual([[910n, 997n], [914n, 1_001n]]);
    expect(transferRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
  });

  it.each([
    ['tx を読めない', () => rpc.tx.mockImplementationOnce(() => Promise.reject(new Error('rpc down')))],
    ['block の時刻を読めない', () => rpc.time.mockImplementationOnce(() => Promise.reject(new Error('rpc down')))],
  ])('%s Transfer から後ろの Transfer は次の回に回す。同じ回の Settled の照合は続ける', async (_name, breakOnce) => {
    showGasless();
    pay(993n, 1);
    pay(994n, 2);
    settle(996n, 3);
    breakOnce();
    await tick();
    // Settled (996) は書く。Transfer の 994 は 993 の後ろなので、この回は照合しない。
    expect(rows()).toEqual([[gaslessId(tx(3)), 'G-1']]);
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [stdId(tx(1)), null],
      [gaslessId(tx(3)), 'G-1'],
    ]);
    // 位置は種類ごと: Transfer は照合し終えた所 (992) の続き − 10 から、Settled は 997 の続き − 10 から。
    expect(transferRanges()).toEqual([[910n, 997n], [982n, 997n]]);
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 997n]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ガスレスの会計でも、1 回 (チェーンごと) に読む tx は 4 つまで。超える Transfer から後ろを次の回に回す', async () => {
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
    expect(transferRanges()).toEqual([[910n, 997n], [983n, 997n]]);
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

describe('getLogs の範囲に制限のある RPC (10 block ずつ・Avalanche の RPC と同じ制限) のガスレスの会計', () => {
  const KAIA_FEE = recoverFeeValue(BILL, 'merchant', KAIA.chainId);
  const rangeError = () =>
    new HttpRequestError({
      url: 'https://rpc.test/v2/key',
      status: 400,
      details: JSON.stringify({
        code: -32600,
        message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.',
      }),
    });
  /** 11 block 以上の範囲は error を返す RPC (Settled・Transfer とも)。 */
  function limitedRpc() {
    const transfers = rpc.transfers.getMockImplementation()!;
    const settled = rpc.logs.getMockImplementation()!;
    rpc.transfers.mockImplementation(async (...args: [number, Address, Address[], bigint, bigint]) => {
      const [, , , from, to] = args;
      if (to - from + 1n > QR_SALE_SMALL_RANGE_BLOCKS) throw rangeError();
      return transfers(...args);
    });
    rpc.logs.mockImplementation(async (...args: [number, Address, Address[], bigint, bigint]) => {
      const [, , , from, to] = args;
      if (to - from + 1n > QR_SALE_SMALL_RANGE_BLOCKS) throw rangeError();
      return settled(...args);
    });
  }
  const chunks = (from: bigint, to: bigint) => {
    const out: bigint[][] = [];
    for (let start = from; start <= to; start += 10n) out.push([start, start + 9n < to ? start + 9n : to]);
    return out;
  };
  const calls = () => rpc.logs.mock.calls.length + rpc.transfers.mock.calls.length;
  const clear = () => {
    rpc.logs.mockClear();
    rpc.transfers.mockClear();
  };

  it('getLogs は種類を合わせて 1 回に 10 回まで。Settled が先に使い、Transfer は残りで先頭 − 90 から続きを読む (範囲を飛ばさない)。普段の回は 2 回ずつ', async () => {
    expect(QR_SALE_MAX_GETLOGS_PER_PASS).toBe(10);
    limitedRpc();
    // QR を出したのは 4 分前 (先頭 − 90 の block も、会計の生きていた間)。
    showGasless(BK, { chain: 'kaia' }, NOW - 240_000);
    settle(945n, 1, { chainId: KAIA.chainId, merchantValue: BILL - KAIA_FEE, feeValue: KAIA_FEE });
    pay(915n, 2, { token: KAIA.address });
    pay(996n, 3, { token: KAIA.address });
    await tick();
    // 1 回目: Settled が範囲の制限を知る 1 回 + 10 block ずつ 9 回 = 10 回 (Kaia・Avalanche は先頭 − 1 まで)。Transfer は読まない。
    expect(settledRanges()).toEqual([[910n, 999n], ...chunks(910n, 999n)]);
    expect(rpc.transfers).not.toHaveBeenCalled();
    expect(rows()).toEqual([[gaslessId(tx(1)), 'G-1']]);
    // 2 回目: Settled は 2 回 (989〜999)。Transfer は残りの 8 回で、先頭 − 90 から 80 block。
    clear();
    await tick();
    expect(settledRanges()).toEqual(chunks(989n, 999n));
    expect(transferRanges()).toEqual(chunks(910n, 989n));
    expect(calls()).toBe(10);
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [gaslessId(tx(1)), 'G-1'],
    ]);
    // 3 回目: Transfer は読めた所 (989) − 10 から先頭 − 1 まで (読めていなかった 990〜999 を飛ばさない)。
    clear();
    await tick();
    expect(transferRanges()).toEqual(chunks(979n, 999n));
    expect(rows()).toEqual([
      [stdId(tx(3)), null],
      [stdId(tx(2)), null],
      [gaslessId(tx(1)), 'G-1'],
    ]);
    // 普段の回 (6 秒で 3 block 進んだ): Settled 2 回 + Transfer 2 回。
    clear();
    chain.head = 1_003n;
    await tick();
    expect(settledRanges()).toEqual(chunks(989n, 1_002n));
    expect(transferRanges()).toEqual(chunks(989n, 1_002n));
    expect(calls()).toBe(4);
  });
});
