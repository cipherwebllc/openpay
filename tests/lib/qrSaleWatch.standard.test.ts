// lib/qrSaleWatch.ts の通常決済の会計 (QR の URL の mode=standard・JPYC): 受取先に届いた JPYC の Transfer と、その tx の
// input の印 (transfer(受取先, 額) + bill key の印) で、その会計の入金と確かめて取引履歴に書く。
// RPC の読み取り (lib/qrSaleRpc.ts) と nonce の式 (軽い差し替え・ガスレスの会計と混ぜる場面だけ) を差し替え、照合・行の
// 組み立て・履歴と印 (localStorage) は実物。時間は fake timer で進める。
// 印の式 (lib/relay/billKeySalt の billKeyStdMark) の golden と照合の純関数は tests/lib/qrSaleHistory.standard.test.ts、
// 払った側の通常決済の行と欄ごとに同じことは tests/components/qrSaleHistory.standardParity.test.tsx が確かめる。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
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
// nonce の式は軽い差し替え (tests/_helpers/fakeForwarderNonce.ts)。ガスレスの会計と混ぜる場面で使う。
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
import type { QrSaleLog, QrSaleTx } from '@/lib/qrSaleRpc';
import { billKeyStdMark } from '@/lib/relay/billKeySalt';
import { QR_SALE_MARKS_KEY } from '@/lib/qrSaleMarks';
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
import { deploymentForSlug } from '@/lib/tokens';
import { buildCheckoutUrl, buildPayUrl, type PayParams } from '@/lib/url';
import { billNonce, markedTransfer, plainTransfer, settledRpcLog, transferRpcLog } from '../_helpers/qrSale';

const ORIGIN = 'https://shop.test';
const FORWARDER: Address = '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER_SHOP: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const CUSTOMER: Address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER_CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
// スマートアカウントの tx を送る bundler と、ERC-4337 の EntryPoint (v0.7)・Safe の口座。
const BUNDLER: Address = '0x4337000000000000000000000000000000000001';
const ENTRY_POINT: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const SAFE: Address = '0x5afe000000000000000000000000000000000002';
// ウォレットの中継 (ガス代を別の token で払う 7702 の中継・2026-11-18 の MetaMask の形)。
const CUSTOMER_RELAYER: Address = '0xc066000000000000000000000000000000000003';
const RELAY: Address = '0xdb9b000000000000000000000000000000000004';
const USDC_LIKE: Address = '0x0000000000000000000000000000000000000bbb';
const BK = 'Zm9vYmFyYmE';
const BK2 = 'a-b_c-d_e-8';
const BK3 = 'QQQQQQQQQQQ';
const ONE = 10n ** 18n;
const POLYGON = deploymentForSlug('jpyc', 'polygon');
const JPYC = POLYGON.address;
const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);
// block n の時刻 (unix 秒)。block 1,000 = NOW・1 block 2 秒。
const blockTime = (n: bigint) => BigInt(NOW / 1000) + (n - 1_000n) * 2n;
// 16 進の英字を含む hash。
const tx = (n: number) => `0x${'cd'.repeat(24)}${n.toString(16).padStart(16, '0')}` as Hex;

// スマートアカウントが中で transfer を呼ぶ tx の input の形。
const HANDLE_OPS = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
]);
const ACCOUNT = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function executeBatch(address[] dest, uint256[] value, bytes[] func)',
]);
const SAFE_ABI = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
]);
const ERC7579 = parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']);
const ZERO: Address = '0x0000000000000000000000000000000000000000';

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
const safeExec = (inner: Hex) =>
  encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [JPYC, 0n, inner, 0, 0n, 0n, 0n, ZERO, ZERO, `0x${'22'.repeat(65)}`],
  });
// ERC-7579 (Kernel 等) の 1 つの呼び出し: executionCalldata = 宛先 (20) ‖ 額 (32) ‖ calldata を詰めた encode。
const erc7579Exec = (inner: Hex) =>
  encodeFunctionData({
    abi: ERC7579,
    functionName: 'execute',
    args: [pad('0x00'), encodePacked(['address', 'uint256', 'bytes'], [JPYC, 0n, inner])],
  });
/** input の中の印の byte の位置 (input の先頭から)。 */
const markOffset = (input: Hex, billKey: string) => (input.indexOf(billKeyStdMark(billKey)!.slice(2)) - 2) / 2;

// チェーンの代わり: 先頭の block と、取り込まれた Transfer・Settled の log と、tx。
const chain = {
  head: 1_000n,
  transfers: [] as QrSaleLog[],
  settled: [] as QrSaleLog[],
  txs: new Map<string, QrSaleTx>(),
};

const payUrl = (over: Partial<PayParams> = {}) =>
  buildPayUrl(ORIGIN, { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'customer', mode: 'standard', amount: '1000', ...over });
const show = (billKey = BK, over: Partial<PayParams> = {}, shownAt = Date.now(), listener?: (e: QrBillRecorded) => void) =>
  showQrBill(
    { billKey, kind: 'pay', url: payUrl({ productName: 'ランチ', receiptNo: 'R-1', ...over }), itemName: 'お支払い' },
    shownAt,
    listener,
  );

/** block に Transfer を足し、その tx を登録する (既定 = お客様の EOA が JPYC へ直接 transfer(受取先, 1,000) + BK の印)。 */
function pay(
  block: bigint,
  n: number,
  over: {
    billKey?: string; value?: bigint; from?: Address; to?: Address; token?: Address; logIndex?: number;
    input?: Hex; txFrom?: Address; txTo?: Address | null; txHash?: string;
  } = {},
) {
  const value = over.value ?? 1_000n * ONE;
  const to = over.to ?? SHOP;
  const hash = over.txHash ?? tx(n);
  chain.transfers.push(
    transferRpcLog({
      token: over.token ?? JPYC, from: over.from ?? CUSTOMER, to, value, txHash: hash, blockNumber: block,
      logIndex: over.logIndex ?? 0,
    }),
  );
  chain.txs.set(hash.toLowerCase(), {
    from: over.txFrom ?? over.from ?? CUSTOMER,
    to: over.txTo === undefined ? JPYC : over.txTo,
    input: over.input ?? markedTransfer(over.billKey ?? BK, to, value),
  });
  return hash;
}

/** ガスレスの会計への Settled を足す (この bill key で署名した 1,000 JPYC = 着金 998・利用料 2)。 */
function settle(block: bigint, n: number, over: { billKey?: string; logIndex?: number; txHash?: string } = {}) {
  const sale = {
    from: CUSTOMER, merchant: SHOP, merchantValue: 998n * ONE, feeValue: 2n * ONE,
    validBefore: blockTime(block) + 290n, chainId: POLYGON.chainId, forwarder: FORWARDER,
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  chain.head = 1_000n;
  chain.transfers = [];
  chain.settled = [];
  chain.txs = new Map();
  hold.forwarders = { [POLYGON.chainId]: FORWARDER };
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

describe('通常決済の会計: 読むもの', () => {
  it('通常決済の QR を出したら、6 秒おきに JPYC の deployment の Transfer (この受取先宛て) を読む。Settled は読まない', async () => {
    show();
    expect(rpc.head).not.toHaveBeenCalled();
    await tick();
    expect(rpc.transfers).toHaveBeenCalledTimes(1);
    expect(rpc.transfers).toHaveBeenCalledWith(POLYGON.chainId, JPYC, [getAddress(SHOP)], 910n, 997n);
    expect(rpc.logs).not.toHaveBeenCalled();
    // 一致する Transfer が無ければ、block の時刻も tx も読まない。
    expect(rpc.time).not.toHaveBeenCalled();
    expect(rpc.tx).not.toHaveBeenCalled();
    chain.head = 1_004n;
    await tick();
    expect(transferRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
  });

  it('forwarder の無いチェーンでも見張る (払う人のウォレットが送る)', async () => {
    hold.forwarders = {};
    show();
    pay(995n, 1);
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
  });

  it('見張らない通常決済の QR (USDC・金額なし・形の違う bill key) では、RPC を 1 回も読まない', async () => {
    const usdc = buildPayUrl(ORIGIN, { to: SHOP, token: 'usdc', chain: 'base', gas: 'customer', mode: 'standard', amount: '5' });
    showQrBill({ billKey: BK, kind: 'pay', url: usdc, itemName: '' }, NOW);
    showQrBill({ billKey: BK2, kind: 'pay', url: payUrl({ amount: undefined }), itemName: '' }, NOW);
    showQrBill({ billKey: 'short', kind: 'pay', url: payUrl(), itemName: '' }, NOW);
    await tick(20);
    expect(rpc.head).not.toHaveBeenCalled();
    expect(rpc.transfers).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('2 つの受取先の通常決済の QR: 1 回の getLogs で両方の受取先の Transfer を読む', async () => {
    show(BK);
    show(BK2, { to: OTHER_SHOP });
    await tick();
    expect(rpc.transfers.mock.calls.map(([, token, merchants]) => [token, merchants])).toEqual([
      [JPYC, [getAddress(SHOP), getAddress(OTHER_SHOP)]],
    ]);
  });
});

describe('印の付いた入金だけを行にする', () => {
  it('額がちょうど + 印 (EOA が JPYC へ直接送った) → 行: 払った側の通常決済の行と同じ欄・会計の写しの明細つき・時刻は block の時刻', async () => {
    show();
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
      merchantAmount: (1_000n * ONE).toString(),
      feeAmount: '0',
      saleAmount: (1_000n * ONE).toString(),
      networkFeeEquivalent: null,
      feeReceiver: env.feeReceiver,
      txHash: tx(1),
      userOpHash: null,
      blockNumber: '995',
      errorMessage: null,
      productName: 'ランチ',
      receiptNo: 'R-1',
    });
    expect(all[0].lineItems).toHaveLength(1);
    expect(marks()).toEqual([tx(1)]);
  });

  it.each([
    ['印なし (今の払う側の transfer そのまま)', { input: plainTransfer(SHOP, 1_000n * ONE) }, true],
    ['別の会計の bill key の印', { billKey: BK2 }, true],
    ['1 wei 少ない額', { value: 1_000n * ONE - 1n }, false],
    ['1 wei 多い額', { value: 1_000n * ONE + 1n }, false],
    ['別の token の address が出した Transfer', { token: USDC_LIKE }, false],
    ['送り手が forwarder (ガスレスの決済の分け前)', { from: FORWARDER }, false],
    ['別の受取先宛て (RPC が絞らずに返した)', { to: OTHER_SHOP }, false],
  ] as const)('%s → 行にしない', async (_name, over, readsTx) => {
    show();
    pay(995n, 1, over);
    // 受取先の topic で絞らない RPC (別の受取先宛ても返す)。
    rpc.transfers.mockImplementation(async () => chain.transfers);
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(window.localStorage.getItem(QR_SALE_MARKS_KEY)).toBeNull();
    expect(hold.appends).toBe(0);
    // 額・受取先・送り手・token が会計と違う Transfer は、block の時刻も tx も読まない。
    expect(rpc.tx).toHaveBeenCalledTimes(readsTx ? 1 : 0);
    expect(rpc.time).toHaveBeenCalledTimes(readsTx ? 1 : 0);
    // 読んだ log は、重ねて読んでも tx を読み直さない。
    await tick(2);
    expect(rpc.tx).toHaveBeenCalledTimes(readsTx ? 1 : 0);
  });

  it('block の時刻が、会計の生きていた間 (表示を始めてから、やめて 60 秒まで・時計のずれ 30 秒) の外なら書かない (tx も読まない)', async () => {
    show(BK, {}, NOW);
    hideQrBill(BK, NOW);
    rpc.transfers.mockImplementation(async () => chain.transfers);
    pay(984n, 1); // NOW − 32 秒: 外
    pay(985n, 2); // NOW − 30 秒: 内 (端)
    pay(1_045n, 3); // NOW + 90 秒: 内 (端)
    pay(1_046n, 4); // NOW + 92 秒: 外
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(3)), null],
      [stdId(tx(2)), 'R-1'],
    ]);
    expect(rpc.tx.mock.calls.map(([, hash]) => hash)).toEqual([tx(2), tx(3)]);
  });

  it.each([
    ['input の後ろに余計な byte がある', { input: `${markedTransfer(BK, SHOP, 1_000n * ONE)}00` as Hex }],
    ['input の前に余計な byte がある', { input: `0x00${markedTransfer(BK, SHOP, 1_000n * ONE).slice(2)}` as Hex }],
    ['印が途中で切れている', { input: markedTransfer(BK, SHOP, 1_000n * ONE).slice(0, -2) as Hex }],
    ['tx の送り手が Transfer の from と違う', { txFrom: OTHER_CUSTOMER }],
    [
      '別の関数 (transferFrom) の後ろに印',
      {
        input: concatHex([
          encodeFunctionData({
            abi: parseAbi(['function transferFrom(address from, address to, uint256 value)']),
            functionName: 'transferFrom',
            args: [CUSTOMER, SHOP, 1_000n * ONE],
          }),
          billKeyStdMark(BK)!,
        ]),
      },
    ],
  ] as const)('EOA が JPYC へ直接送った tx で、%s → 行にしない (ちょうど同じ input だけ)', async (_name, over) => {
    show();
    pay(995n, 1, over);
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(1);
    expect(loadHistory()).toEqual([]);
  });

  it.each([
    ['ERC-4337 の bundler の handleOps (口座の execute)', () => handleOps(execute(markedTransfer(BK, SHOP, 1_000n * ONE))), BUNDLER, ENTRY_POINT, 12],
    ['Safe の execTransaction', () => safeExec(markedTransfer(BK, SHOP, 1_000n * ONE)), CUSTOMER, SAFE, 8],
    ['ERC-7579 (Kernel 等) の詰めた encode', () => erc7579Exec(markedTransfer(BK, SHOP, 1_000n * ONE)), BUNDLER, CUSTOMER, 28],
    ['7702 で委任した EOA が自分の execute を呼んだ', () => execute(markedTransfer(BK, SHOP, 1_000n * ONE)), CUSTOMER, CUSTOMER, 8],
  ] as const)(
    'スマートアカウントの tx: input の中に「transfer(受取先, 額) + 印」の並びがある → 行 (%s)',
    async (_name, input, txFrom, txTo, offsetMod32) => {
      show();
      pay(995n, 1, { input: input(), txFrom, txTo });
      await tick();
      expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
      // お客様は Transfer の from (tx の送り手ではない)。
      expect(loadHistory()[0].customer).toBe(getAddress(CUSTOMER));
      // 印は input の先頭から 32 byte の倍数の位置には来ない (包む関数の selector の 4 byte がずれを作る・詰めた encode)。
      // 照合は「transfer の calldata の直後の 32 byte」で見る (lib/qrSaleHistory.ts の stdMarkCount)。
      expect(markOffset(input(), BK) % 32).toBe(offsetMod32);
    },
  );

  it('ウォレットの中継の tx (同じ「transfer + 印」が署名した中身と実行する中身の 2 か所・Transfer は 1 つ) → 1 行 (2026-11-18 の実機: MetaMask がガス代を USDC で払った)', async () => {
    show();
    const inner = execute(markedTransfer(BK, SHOP, 1_000n * ONE));
    // 中継の contract への呼び出し: 署名した実行の中身と、実行する中身に、同じ並びが入る。
    const relay = encodeFunctionData({
      abi: parseAbi(['function relay(bytes signedCall, bytes execCall)']),
      functionName: 'relay',
      args: [inner, inner],
    });
    expect(relay.split(markedTransfer(BK, SHOP, 1_000n * ONE).slice(2)).length - 1).toBe(2);
    pay(995n, 1, { input: relay, txFrom: CUSTOMER_RELAYER, txTo: RELAY });
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
    expect(loadHistory()[0].customer).toBe(getAddress(CUSTOMER));
  });

  it.each([
    ['印だけ (transfer の calldata が前に無い・input の word の境界にある)', () => {
      const words = `${'00'.repeat(32)}${billKeyStdMark(BK)!.slice(2)}`;
      const input = `0xdeadbeef${'00'.repeat(28)}${words}` as Hex;
      expect(markOffset(input, BK) % 32).toBe(0);
      return input;
    }],
    ['transfer の calldata と印の間に 1 byte', () =>
      handleOps(execute(concatHex([plainTransfer(SHOP, 1_000n * ONE), '0x00', billKeyStdMark(BK)!])))],
    ['半 byte ずれた位置に「transfer + 印」の並び', () =>
      `0x0${handleOps(execute(markedTransfer(BK, SHOP, 1_000n * ONE))).slice(2)}0` as Hex],
    ['額の違う transfer の後ろに印', () => handleOps(execute(markedTransfer(BK, SHOP, 999n * ONE)))],
    ['別の受取先への transfer の後ろに印', () => handleOps(execute(markedTransfer(BK, OTHER_SHOP, 1_000n * ONE)))],
  ] as const)('スマートアカウントの tx で、%s → 行にしない', async (_name, input) => {
    show();
    pay(995n, 1, { input: input(), txFrom: BUNDLER, txTo: ENTRY_POINT });
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(1);
    expect(loadHistory()).toEqual([]);
  });

  it('同じ会計への 2 件目の入金は明細なしの行。同じ block の中では log の番号の小さい方が 1 件目 (RPC が新しい順に返しても)', async () => {
    show();
    pay(995n, 2, { logIndex: 7 });
    pay(995n, 1, { logIndex: 3 });
    pay(994n, 3);
    rpc.transfers.mockImplementation(async () => [...chain.transfers].reverse());
    await tick();
    const byId = Object.fromEntries(loadHistory().map((e) => [e.id, e]));
    expect(byId[stdId(tx(3))]).toMatchObject({ receiptNo: 'R-1', productName: 'ランチ' });
    expect(byId[stdId(tx(1))]).toMatchObject({ receiptNo: null, lineItems: null, storeName: '' });
    expect(byId[stdId(tx(2))]).toMatchObject({ receiptNo: null, lineItems: null });
  });

  it('レジ (/checkout) の通常決済の会計: 明細の合計 − 値引き の額 + 印 → 明細・商品名・管理番号つきの行', async () => {
    const url = buildCheckoutUrl(ORIGIN, {
      to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'customer', mode: 'standard', receiptNo: 'R-0012', discount: '80',
      items: [{ name: 'コーヒー', qty: 2, price: '500' }, { name: 'ケーキ', qty: 1, price: '480' }],
    });
    showQrBill({ billKey: BK, kind: 'checkout', url, itemName: '' }, NOW);
    pay(995n, 1, { value: 1_400n * ONE });
    await tick();
    expect(loadHistory()[0]).toMatchObject({
      id: stdId(tx(1)), productName: 'コーヒー, ケーキ', receiptNo: 'R-0012', saleAmount: (1_400n * ONE).toString(),
      merchantAmount: (1_400n * ONE).toString(), storeName: '',
    });
    // 値引きは明細の行に按分する (払った側と同じ buildCheckoutLineItems)。
    expect(loadHistory()[0].lineItems).toHaveLength(2);
  });
});

describe('1 tx 1 行・払った側の行', () => {
  it('同じ tx を Settled と Transfer が拾う (forwarder の settle: Settled + forwarder から受取先への Transfer) → 1 行 (ガスレスの行)・tx は読まない', async () => {
    // ガスレスの会計 (1,000 JPYC) と、着金額と同じ額 (998) の通常決済の会計。
    showQrBill(
      { billKey: BK, kind: 'pay', url: payUrl({ mode: 'gasless', gas: 'merchant', receiptNo: 'G-1' }), itemName: '' },
      NOW,
    );
    show(BK2, { amount: '998', receiptNo: 'S-1' });
    settle(995n, 1, { logIndex: 0 });
    pay(995n, 1, { from: FORWARDER, value: 998n * ONE, logIndex: 1, billKey: BK2 });
    await tick();
    expect(rows()).toEqual([[`batch-${tx(1)}`, 'G-1']]);
    expect(rpc.tx).not.toHaveBeenCalled();
  });

  // Settled の照合・保存は Transfer の読み取りを待たずに先に終える (lib/qrSaleWatch.ts の頭の注記)。log の番号が Transfer の方が
  // 小さくても、行は Settled の会計の行 (前は、log の番号の小さい方の会計の行だった)。
  it.each([
    ['log の番号は Settled が先', 0, 1, [`batch-${tx(1)}`, 'G-1']],
    ['log の番号は Transfer が先', 1, 0, [`batch-${tx(1)}`, 'G-1']],
  ] as const)(
    '1 つの tx に、ガスレスの会計の Settled と、通常決済の会計の印の付いた Transfer の両方 (%s) → 1 行 (Settled の会計の行)',
    async (_name, settledIndex, transferIndex, row) => {
      showQrBill(
        { billKey: BK, kind: 'pay', url: payUrl({ mode: 'gasless', gas: 'merchant', receiptNo: 'G-1' }), itemName: '' },
        NOW,
      );
      show(BK2, { receiptNo: 'S-1' });
      settle(995n, 1, { logIndex: settledIndex });
      pay(995n, 1, {
        billKey: BK2, logIndex: transferIndex, input: handleOps(execute(markedTransfer(BK2, SHOP, 1_000n * ONE))),
        txFrom: BUNDLER, txTo: ENTRY_POINT,
      });
      await tick();
      expect(rows()).toEqual([row]);
      expect(marks()).toEqual([tx(1)]);
      expect(hold.appends).toBe(1);
    },
  );

  it('印が 1 つの tx に、同じ会計の額の Transfer が 2 つ: 印で数える Transfer は 1 つだけ (同じ会計の 2 件目として数えない)', async () => {
    const seen: QrBillRecorded[] = [];
    show(BK, { receiptNo: 'R-1' }, NOW, (e) => seen.push(e));
    // AA の 1 つの tx に、印つきの transfer が 1 つと、印の無い同じ額の transfer が 1 つ (印は 1 つだけ)。
    const input = handleOps(executeBatch([markedTransfer(BK, SHOP, 1_000n * ONE), plainTransfer(SHOP, 1_000n * ONE)]));
    pay(995n, 1, { logIndex: 0, input, txFrom: BUNDLER, txTo: ENTRY_POINT });
    pay(995n, 1, { logIndex: 1, input, txFrom: BUNDLER, txTo: ENTRY_POINT });
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
    // この会計の知らせは 1 件目だけ。次の別の tx の入金が 2 件目 (印 1 つを 2 回数えていない)。
    expect(seen).toEqual([{ billKey: BK, count: 1, amount: (1_000n * ONE).toString() }]);
    chain.head = 1_004n;
    pay(1_000n, 2);
    await tick();
    expect(seen.map((e) => e.count)).toEqual([1, 2]);
  });

  it.each([
    ['別の会計の印つき', () => markedTransfer(BK2, SHOP, 1_000n * ONE)],
    ['印なし', () => plainTransfer(SHOP, 1_000n * ONE)],
  ])(
    'Transfer が 1 つの tx の input に transfer が 2 つ (%s) あれば、どの会計の入金ともしない (1 つの入金で 2 つの会計を確かめない)',
    async (_name, second) => {
      const a: QrBillRecorded[] = [];
      const b: QrBillRecorded[] = [];
      show(BK, { receiptNo: 'R-1' }, NOW, (e) => a.push(e));
      show(BK2, { receiptNo: 'R-2' }, NOW, (e) => b.push(e));
      const input = handleOps(executeBatch([markedTransfer(BK, SHOP, 1_000n * ONE), second()]));
      pay(995n, 1, { logIndex: 0, input, txFrom: BUNDLER, txTo: ENTRY_POINT });
      await tick();
      expect(loadHistory()).toEqual([]);
      expect(a).toEqual([]);
      expect(b).toEqual([]);
    },
  );

  it('1 tx に候補 2 つ (同じ額の 2 つの会計への Transfer が 1 つの bundle に): 1 行。印はそれぞれの会計に 1 つずつ数える', async () => {
    const a: QrBillRecorded[] = [];
    const b: QrBillRecorded[] = [];
    show(BK, { receiptNo: 'R-1' }, NOW, (e) => a.push(e));
    show(BK2, { receiptNo: 'R-2' }, NOW, (e) => b.push(e));
    const input = handleOps(
      executeBatch([markedTransfer(BK, SHOP, 1_000n * ONE), markedTransfer(BK2, SHOP, 1_000n * ONE)]),
    );
    pay(995n, 1, { logIndex: 0, input, txFrom: BUNDLER, txTo: ENTRY_POINT });
    pay(995n, 1, { logIndex: 1, input, txFrom: BUNDLER, txTo: ENTRY_POINT, from: OTHER_CUSTOMER });
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
    // 同じ tx の 2 つ目の Transfer では tx を読み直さない。
    expect(rpc.tx).toHaveBeenCalledTimes(1);
    expect(a).toEqual([{ billKey: BK, count: 1, amount: (1_000n * ONE).toString() }]);
    // BK2 の会計の 1 件目は同じ tx の中の入金 (行は書かない)。次の別の tx の入金は 2 件目 (明細なし)。
    expect(b).toEqual([]);
    chain.head = 1_004n;
    pay(1_000n, 2, { billKey: BK2 });
    await tick();
    expect(loadHistory()[0]).toMatchObject({ id: stdId(tx(2)), receiptNo: null, lineItems: null });
    expect(b).toEqual([{ billKey: BK2, count: 2, amount: (1_000n * ONE).toString() }]);
  });

  it('印が A・A・B で Transfer が 2 つの tx (2 つの会計を同時に見張る): どの会計の入金ともしない (A に 2 つ数えて B を 0 にしない)', async () => {
    const a: QrBillRecorded[] = [];
    const b: QrBillRecorded[] = [];
    show(BK, { receiptNo: 'R-1' }, NOW, (e) => a.push(e));
    show(BK2, { receiptNo: 'R-2' }, NOW, (e) => b.push(e));
    const input = handleOps(
      executeBatch([
        markedTransfer(BK, SHOP, 1_000n * ONE),
        markedTransfer(BK, SHOP, 1_000n * ONE),
        markedTransfer(BK2, SHOP, 1_000n * ONE),
      ]),
    );
    pay(995n, 1, { logIndex: 0, input, txFrom: BUNDLER, txTo: ENTRY_POINT });
    pay(995n, 1, { logIndex: 1, input, txFrom: BUNDLER, txTo: ENTRY_POINT, from: OTHER_CUSTOMER });
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    // 次の別の tx の入金は、それぞれの会計の 1 件目 (前の tx を数えていない)。
    chain.head = 1_004n;
    pay(1_000n, 2, { billKey: BK2 });
    await tick();
    expect(b).toEqual([{ billKey: BK2, count: 1, amount: (1_000n * ONE).toString() }]);
    expect(a).toEqual([]);
  });

  it('同じ額の 2 つの会計への 1 つの Transfer: input にある印の会計の行 (先に出した会計ではない)', async () => {
    show(BK, { receiptNo: 'R-1' });
    show(BK2, { receiptNo: 'R-2' });
    pay(995n, 1, { billKey: BK2 });
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'R-2']]);
  });

  it('払った側の行が先にある (同じブラウザで払った) → 書かない (印だけ付ける)・知らせない', async () => {
    appendHistory(
      buildHistoryEntry({
        flow: 'standard-merchant', status: 'success', chainId: POLYGON.chainId, chainSlug: 'polygon', asset: 'jpyc',
        tokenAddress: JPYC, payMode: 'standard', gasMode: null, merchant: SHOP, merchantAmount: 1_000n * ONE,
        customer: CUSTOMER, feeReceiver: env.feeReceiver, feeAmount: 0n, saleAmount: 1_000n * ONE,
        networkFeeEquivalent: null, txHash: tx(1), userOpHash: null, blockNumber: 995n, errorMessage: null,
        storeName: 'payer wrote this', note: '',
      }),
    );
    hold.appends = 0;
    const listener = vi.fn();
    show(BK, {}, NOW, listener);
    pay(995n, 1);
    await tick();
    expect(hold.appends).toBe(0);
    expect(loadHistory()).toHaveLength(1);
    expect(loadHistory()[0].storeName).toBe('payer wrote this');
    expect(marks()).toEqual([tx(1)]);
    expect(listener).not.toHaveBeenCalled();
  });
});

// 正しい input (印つきの transfer) から末尾の 1 桁を落としたもの (byte にならない応答)。
const ODD_INPUT = markedTransfer(BK, SHOP, 1_000n * ONE).slice(0, -1) as Hex;

describe('読み取りの失敗・上限・順', () => {
  it.each([
    ['getTransaction の失敗', () => Promise.reject(new Error('rpc down'))],
    ['tx が無い (null)', () => Promise.resolve(null)],
    ['形の違う応答 (input が hex でない)', () => Promise.resolve({ from: CUSTOMER, to: JPYC, input: 'not hex' })],
    ['形の違う応答 (from が address でない)', () => Promise.resolve({ from: '0x12', to: JPYC, input: '0x' })],
    [
      '形の違う応答 (input が奇数桁 = 末尾の 1 桁が欠けた正しい input)',
      () => Promise.resolve({ from: CUSTOMER, to: JPYC, input: ODD_INPUT }),
    ],
  ])('%s → 読んだことにせず、次の回にその log から読み直す', async (_name, broken) => {
    show();
    pay(994n, 1);
    rpc.tx.mockImplementationOnce(broken);
    await tick();
    expect(loadHistory()).toEqual([]);
    chain.head = 1_002n;
    await tick();
    // 照合し終えた所 (993) の続きから読み直す (993 − 10 = 983 から)。
    expect(transferRanges()).toEqual([[910n, 997n], [983n, 999n]]);
    expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
    expect(rpc.tx).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tx を読めない Transfer から後ろの Transfer は次の回に回す (古い順・明細は古い方)。Settled の照合は同じ回に続ける', async () => {
    showQrBill(
      { billKey: BK3, kind: 'pay', url: payUrl({ mode: 'gasless', gas: 'merchant', receiptNo: 'G-1' }), itemName: '' },
      NOW,
    );
    show(BK);
    pay(994n, 1);
    pay(995n, 2);
    settle(996n, 3, { billKey: BK3 });
    rpc.tx.mockImplementationOnce(() => Promise.reject(new Error('rpc down')));
    await tick();
    // Settled (996) は書く。Transfer の 995 は 994 の後ろなので、この回は読まない。
    expect(rows()).toEqual([[`batch-${tx(3)}`, 'G-1']]);
    expect(rpc.tx.mock.calls.map(([, hash]) => hash)).toEqual([tx(1)]);
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [stdId(tx(1)), 'R-1'],
      [`batch-${tx(3)}`, 'G-1'],
    ]);
    // 位置は種類ごと: Transfer は 993 の続き − 10 から、Settled は 997 の続き − 10 から。
    expect(transferRanges()).toEqual([[910n, 997n], [983n, 997n]]);
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 997n]]);
  });

  it('block の時刻を読めない Transfer も、読んだことにせず次の回に読み直す', async () => {
    show();
    pay(995n, 1);
    rpc.time.mockImplementationOnce(() => Promise.reject(new Error('rpc down')));
    await tick();
    expect(loadHistory()).toEqual([]);
    expect(rpc.tx).not.toHaveBeenCalled();
    await tick();
    expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
  });

  it('1 回 (チェーンごと) に読む tx は 4 つまで。超える Transfer から後ろを次の回に回し、古い順に全部を照合する', async () => {
    expect(QR_SALE_MAX_TX_READS_PER_PASS).toBe(4);
    show();
    // 同じ額の関係ない入金 (印なし) 5 つの後に、この会計の入金。
    for (let i = 1; i <= 5; i += 1) pay(BigInt(989 + i), i, { input: plainTransfer(SHOP, 1_000n * ONE) });
    pay(996n, 6);
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(4);
    expect(loadHistory()).toEqual([]);
    await tick();
    expect(rpc.tx).toHaveBeenCalledTimes(6);
    expect(rows()).toEqual([[stdId(tx(6)), 'R-1']]);
    // 2 回目は、照合し終えた所 (993) の続き − 10 から。
    expect(transferRanges()).toEqual([[910n, 997n], [983n, 997n]]);
  });

  it('Transfer の getLogs が読めない回: Transfer の位置は変えず (次の回に同じ所から)、Settled は読んで進める', async () => {
    showQrBill(
      { billKey: BK3, kind: 'pay', url: payUrl({ mode: 'gasless', gas: 'merchant', receiptNo: 'G-1' }), itemName: '' },
      NOW,
    );
    show(BK);
    pay(994n, 1);
    settle(995n, 2, { billKey: BK3 });
    rpc.transfers.mockImplementationOnce(async () => {
      throw new HttpRequestError({ url: 'https://rpc.test', status: 503, details: 'upstream down' });
    });
    await tick();
    expect(rows()).toEqual([[`batch-${tx(2)}`, 'G-1']]);
    chain.head = 1_004n;
    await tick();
    expect(rows()).toEqual([
      [stdId(tx(1)), 'R-1'],
      [`batch-${tx(2)}`, 'G-1'],
    ]);
    // Transfer は 1 度も読めていなかった = 次の回も先頭 − 90 から。Settled は前回の続き − 10 から。
    expect(transferRanges()).toEqual([[910n, 997n], [914n, 1_001n]]);
    expect(settledRanges()).toEqual([[910n, 997n], [987n, 1_001n]]);
  });
});

describe('getLogs の範囲に制限のある RPC (10 block ずつ) と 1 回の上限', () => {
  const rangeError = () =>
    new HttpRequestError({
      url: 'https://rpc.test/v2/key',
      status: 400,
      details: JSON.stringify({
        code: -32600,
        message: 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.',
      }),
    });
  /** 11 block 以上の範囲は error を返す RPC (Settled・Transfer とも)。fail は 10 block までの範囲の Transfer で失敗を差し込む。 */
  function limitedRpc(fail: (from: bigint, to: bigint) => Error | null = () => null) {
    const transfers = rpc.transfers.getMockImplementation()!;
    const settled = rpc.logs.getMockImplementation()!;
    rpc.transfers.mockImplementation(async (...args: [number, Address, Address[], bigint, bigint]) => {
      const [, , , from, to] = args;
      if (to - from + 1n > QR_SALE_SMALL_RANGE_BLOCKS) throw rangeError();
      const error = fail(from, to);
      if (error) throw error;
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

  it('通常決済の会計だけ: 範囲の制限を知ったら 10 block ずつ。途中の 1 つが失敗したら、読めた所までで止め、次の回はその続きから (未読の範囲を越えない)', async () => {
    let failed = false;
    limitedRpc((from) => {
      if (from !== 950n || failed) return null;
      failed = true;
      return new Error('upstream 503');
    });
    show(BK, {}, NOW - 240_000);
    pay(945n, 1);
    pay(955n, 2);
    await tick();
    expect(transferRanges()).toEqual([[910n, 997n], ...chunks(910n, 959n)]);
    expect(rows()).toEqual([[stdId(tx(1)), 'R-1']]);
    rpc.transfers.mockClear();
    await tick();
    expect(transferRanges()).toEqual(chunks(939n, 997n));
    expect(rows()).toEqual([
      [stdId(tx(2)), null],
      [stdId(tx(1)), 'R-1'],
    ]);
  });

  it('両方の会計がある 10 block ずつのチェーン: getLogs は種類を合わせて 1 回に 10 回まで。Settled が先に使い、Transfer は残りで続きから読む', async () => {
    expect(QR_SALE_MAX_GETLOGS_PER_PASS).toBe(10);
    limitedRpc();
    showQrBill(
      { billKey: BK3, kind: 'pay', url: payUrl({ mode: 'gasless', gas: 'merchant', receiptNo: 'G-1' }), itemName: '' },
      NOW - 240_000,
    );
    show(BK, {}, NOW - 240_000);
    settle(945n, 1, { billKey: BK3 });
    pay(946n, 2);
    await tick();
    // 1 回目: Settled が範囲の制限を知る 1 回 + 10 block ずつ 9 回 = 10 回。Transfer はこの回は読まない。
    expect(settledRanges()).toEqual([[910n, 997n], ...chunks(910n, 997n)]);
    expect(rpc.transfers).not.toHaveBeenCalled();
    expect(rows()).toEqual([[`batch-${tx(1)}`, 'G-1']]);
    // 2 回目: Settled は 2 回 (987〜997)・Transfer は残りの 8 回で、先頭 − 90 から 80 block。
    rpc.logs.mockClear();
    await tick();
    expect(settledRanges()).toEqual(chunks(987n, 997n));
    expect(transferRanges()).toEqual(chunks(910n, 989n));
    expect(rpc.logs.mock.calls.length + rpc.transfers.mock.calls.length).toBe(10);
    expect(rows()).toEqual([
      [stdId(tx(2)), 'R-1'],
      [`batch-${tx(1)}`, 'G-1'],
    ]);
    // 3 回目: Transfer は読めた所 (989) − 10 から。
    rpc.logs.mockClear();
    rpc.transfers.mockClear();
    await tick();
    expect(transferRanges()).toEqual(chunks(979n, 997n));
  });
});

describe('画面への知らせ (通常決済の行も、ガスレスの行と同じ)', () => {
  it('1 件目 → count 1・2 件目 → count 2。額は書いた行の saleAmount (請求額)', async () => {
    const events: QrBillRecorded[] = [];
    show(BK, {}, NOW, (e) => events.push(e));
    pay(994n, 1);
    pay(995n, 2);
    await tick();
    expect(events).toEqual([
      { billKey: BK, count: 1, amount: (1_000n * ONE).toString() },
      { billKey: BK, count: 2, amount: (1_000n * ONE).toString() },
    ]);
    expect(loadHistory().every((e) => e.saleAmount === events[0].amount)).toBe(true);
  });

  it('行を履歴に書けなかった (黙った失敗) → notSaved つきで知らせる (count・額は同じ数え方)。印は残り、書き直さない', async () => {
    const events: QrBillRecorded[] = [];
    show(BK, {}, NOW, (e) => events.push(e));
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
    expect(events).toEqual([{ billKey: BK, count: 1, amount: (1_000n * ONE).toString(), notSaved: true }]);
    await tick(2);
    expect(rows()).toEqual([]);
    expect(hold.appends).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('受け手が throw しても、行は書かれ、記録を続ける (警告は 1 回)', async () => {
    const listener = vi.fn(() => {
      throw new Error('setState failed');
    });
    show(BK, {}, NOW, listener);
    pay(994n, 1);
    pay(995n, 2);
    await tick();
    expect(loadHistory()).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('qrSale.notify_failed');
  });
});

describe('止めた後', () => {
  it('tx を待っている間に /create を離れたら (stop)、後から返っても行を書かない', async () => {
    let release!: (value: QrSaleTx) => void;
    show();
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
