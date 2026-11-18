import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  concatHex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  numberToHex,
  size,
  type Address,
  type Hex,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  WagmiProvider,
  createConfig,
  createConnector,
  http,
  type ResolvedRegister,
} from 'wagmi';
import { connect } from 'wagmi/actions';
import { STANDARD_INTENT_STORAGE_KEY, loadStandardIntent } from '@/lib/paymentIntentStorage';
import { standardWalletRequestElsewhere } from '@/lib/standardPaymentOutstanding';
import { readQrStdBill, stdMarkCount, stdTransferCalldata } from '@/lib/qrSaleHistory';
import { buildPayUrl } from '@/lib/url';
import { logPaymentEvent } from '@/lib/paymentLog';
import { isUserRejection } from '@/lib/walletErrors';
import { jsonWithBigint } from '../_helpers/relayAttemptCapture';
import goldenFromMain from '../fixtures/stdBillMarkGoldenHook.json';

// K4b: 通常決済の hook (useStandardPayment) の mutate の第 2 引数 dataSuffix (会計の印) が、ウォレットへ送る calldata に
// どう載るか。wagmi の useWriteContract は本物のまま (本物の @wagmi/core の writeContract・viem・TanStack Query の Mutation)。
// mock は境界だけ: ウォレット (EIP-1193 の request = 承認・拒否・失敗まで止めておける promise) と、receipt の照会。
//   - dataSuffix を渡さない送金 (試しのスイッチ OFF・ほかの全員) は main と同じ: 外から見える全部 (ウォレットへの要求・
//     writeContract の引数・保存の intent の各段・登録簿・決済のログ・結果) が、main 956eb4ff の hook で採った GOLDEN
//     (tests/fixtures/stdBillMarkGoldenHook.json) と 1 byte も同じ。
//     GOLDEN の採り方: hooks/useStandardPayment.ts を main 956eb4ff のものにして
//     STD_BILL_MARK_GOLDEN_CAPTURE=<書き出す dir> npx vitest run tests/hooks/useStandardPayment.dataSuffix.test.tsx -t 'GOLDEN を採る'
//     → 書き出された hook.json を tests/fixtures/stdBillMarkGoldenHook.json に置く (新しい code から写さない)。
//   - 渡した送金は transfer(受取先, 額) + 印 の 100 byte で、お店の端末の照合 (lib/qrSaleHistory.ts) の calldata と同じ。
//   - 利用料の transfer・保存する intent には印が無い。
//   - MUST-2: 印は writeContract に渡す 1 つの object の中 (登録簿と unmount の後の保存は object の同一性で見る)・送信待ちも対。
//   - MUST-1: 印つきの送信は、その画面で 1 回まで。印つきで送る直前に同期で予約し、その後の送信は印なし (印つき A の応答待ちの
//     間の B も)。予約を解くのは、ウォレットが投げた元の error (cause のいちばん奥) の code が EIP-1193 の 4001 で (途中に 4001 で
//     ない code が無く)、その 4001 がウォレット自身の答えである接続 (injected・WalletConnect) のときだけ (文言だけの「拒否」では
//     解かない)。receipt・revert・置換は追わない。
// 兄弟の useStandardPayment.unmount.test.tsx と同じ形の harness (この file の分だけを写した)。
type ReceiptState = {
  data:
    | {
        status: 'success' | 'reverted';
        blockNumber: bigint;
        transactionHash: Hex;
        from: Address;
        logs: { address: Address; topics: Hex[]; data: Hex }[];
      }
    | undefined;
  error: Error | null;
  isSuccess: boolean;
  isError: boolean;
  refetch: () => void;
};
const NO_RECEIPT: ReceiptState = { data: undefined, error: null, isSuccess: false, isError: false, refetch: () => {} };
const receiptByHash = new Map<Hex, ReceiptState>();
const useAccountMock = vi.fn();
const publicClientMock = { getTransactionReceipt: vi.fn() };

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>();
  return {
    ...actual,
    useAccount: () => useAccountMock(),
    usePublicClient: () => publicClientMock,
    useWaitForTransactionReceipt: ({ hash }: { hash: Hex | undefined }) =>
      (hash !== undefined ? receiptByHash.get(hash) : undefined) ?? NO_RECEIPT,
  };
});
vi.mock('@/lib/paymentLog', () => ({
  logPaymentEvent: vi.fn(),
  buildPaymentLogEvent: (ctx: object, outcome: object) => ({ ...ctx, ...outcome }),
}));

import { useStandardPayment, type StandardPaymentParams } from '@/hooks/useStandardPayment';

const CHAIN_ID = baseSepolia.id;
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const FEE_RECEIVER: Address = '0xdead000000000000000000000000000000001234';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const MERCHANT_TX: Hex = `0x${'a'.repeat(64)}`;
const FEE_TX: Hex = `0x${'b'.repeat(64)}`;
const NEXT_TX: Hex = `0x${'c'.repeat(64)}`;
const CONTEXT_KEY: Hex = `0x${'1'.repeat(64)}`;
// お店が画面の QR に載せる会計 (JPYC の通常決済・金額あり)。受取先と額は、お店の端末が同じ URL から作る期待値。
const BK = 'Zm9vYmFyYmE';
// tests/lib/billKeySalt.test.ts の golden (cast で計算した billKeyStdMark('Zm9vYmFyYmE'))。
const MARK: Hex = '0x958ae5e2bac7dd1aa8fc9dec6e21f67bd131f20780d3992b9b873d6c4754a317';
const SHOP: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BILL = readQrStdBill({
  billKey: BK,
  kind: 'pay',
  url: buildPayUrl('https://shop.test', { to: SHOP, token: 'jpyc', chain: 'polygon', gas: 'customer', mode: 'standard', amount: '1000' }),
  itemName: '',
})!;

// 払う側の通常決済の mutate の引数 (受取先・額はお店の会計の期待値と同じ・token と chain はこの harness のもの)。
const PARAMS: StandardPaymentParams = {
  tokenAddress: TOKEN,
  merchant: BILL.merchant,
  merchantAmount: BILL.expected.value,
  feeReceiver: FEE_RECEIVER,
  feeAmount: 5n,
  saleAmount: BILL.expected.saleAmount,
  chainId: CHAIN_ID,
  contextKey: CONTEXT_KEY,
};
const PARAMS_NO_FEE: StandardPaymentParams = { ...PARAMS, feeAmount: 0n };
const MERCHANT_CALLDATA = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'transfer',
  args: [BILL.merchant, BILL.expected.value],
});
const FEE_CALLDATA = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [FEE_RECEIVER, 5n] });
// main の writeContract の引数の object の key (印の無い送金はこれと同じ形)。
const MAIN_VAR_KEYS = ['chainId', 'address', 'abi', 'functionName', 'args'];

type WalletSend = {
  tx: { to?: string; data?: Hex; from?: string };
  approve: (hash: Hex) => void;
  reject: () => void;
  fail: () => void;
  // ウォレット (provider) が投げる error をそのまま決める。
  rejectWith: (error: unknown) => void;
  settled: boolean;
};
let walletSends: WalletSend[] = [];

function walletRequest({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
  if (method === 'eth_chainId') return Promise.resolve(numberToHex(CHAIN_ID));
  if (method === 'eth_sendTransaction') {
    return new Promise<Hex>((resolve, reject) => {
      const send: WalletSend = {
        tx: (params as WalletSend['tx'][])[0],
        approve: (hash) => {
          send.settled = true;
          resolve(hash);
        },
        // EIP-1193 のユーザーの拒否 (code 4001)。
        reject: () => {
          send.settled = true;
          reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
        },
        // ウォレットが送れなかった (余った calldata を拒む口座・見積りの失敗など。ユーザーの拒否ではない)。
        fail: () => {
          send.settled = true;
          reject(Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }));
        },
        rejectWith: (error) => {
          send.settled = true;
          reject(error);
        },
        settled: false,
      };
      walletSends.push(send);
    });
  }
  return Promise.reject(new Error(`unexpected wallet method: ${method}`));
}

const NO_HOOK = {};
const outstandingRequest = () => standardWalletRequestElsewhere(NO_HOOK);
const SUBMITTED_AT = 1_700_000_000_000;
function atTime<T>(at: number, run: () => T): T {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    return run();
  } finally {
    clock.mockRestore();
  }
}

const testWallet = createConnector<{ request: typeof walletRequest }>(() => ({
  id: 'test-wallet',
  name: 'Test Wallet',
  type: 'test-wallet',
  connect: (async () => ({ accounts: [CUSTOMER], chainId: CHAIN_ID })) as never,
  disconnect: async () => {},
  getAccounts: async () => [CUSTOMER],
  getChainId: async () => CHAIN_ID,
  getProvider: async () => ({ request: walletRequest }),
  isAuthorized: async () => true,
  onAccountsChanged: () => {},
  onChainChanged: () => {},
  onDisconnect: () => {},
}));

async function makeTab() {
  const config = createConfig({
    chains: [baseSepolia],
    connectors: [testWallet],
    multiInjectedProviderDiscovery: false,
    storage: null,
    transports: { [baseSepolia.id]: http('http://127.0.0.1:9') },
  });
  await connect(config, { connector: config.connectors[0] });
  const providerConfig = config as unknown as ResolvedRegister['config'];
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <WagmiProvider config={providerConfig} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    );
  }
  function renderScreen() {
    return renderHook(() => useStandardPayment(), { wrapper: Wrapper });
  }
  async function mountScreen() {
    const view = renderScreen();
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    return view;
  }
  // writeContract に渡した variables (作った順・unmount の後も Mutation は cache に残る)。
  const mutationVariables = () =>
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables as Record<string, unknown>);
  const mutationStatuses = () => queryClient.getMutationCache().getAll().map((mutation) => mutation.state.status);
  return { renderScreen, mountScreen, mutationVariables, mutationStatuses };
}
type Screen = Awaited<ReturnType<Awaited<ReturnType<typeof makeTab>>['mountScreen']>>;

function receipt(hash: Hex, status: 'success' | 'reverted'): ReceiptState {
  return {
    data: { status, blockNumber: 100n, transactionHash: hash, from: CUSTOMER, logs: [] },
    error: null,
    isSuccess: true,
    isError: false,
    refetch: () => {},
  };
}

async function waitForWalletSends(count: number) {
  await waitFor(() => expect(walletSends).toHaveLength(count));
}

const byteLength = (data: Hex | undefined) => size(data ?? '0x');

// 決済のログ (lib/standardPaymentLog → logPaymentEvent) に送った中身の全部 (印が入っていないかを見る)。
const loggedText = () => jsonWithBigint(vi.mocked(logPaymentEvent).mock.calls);
// error と cause の連なりの、名前と code (viem・wagmi が包んだ形を、本物の node_modules で固定する)。
function errorChain(error: unknown): { name: unknown; code: unknown }[] {
  const out: { name: unknown; code: unknown }[] = [];
  for (let e = error; typeof e === 'object' && e !== null && out.length < 10; e = (e as { cause?: unknown }).cause) {
    out.push({ name: (e as { name?: unknown }).name, code: (e as { code?: unknown }).code });
  }
  return out;
}
// error の文と cause の連なりの文の全部 (ログ・画面に出る文に印が入っていないかを見る)。
function errorTexts(error: unknown): string {
  const out: string[] = [];
  for (let e = error; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) out.push(e.message);
  return out.join('\n');
}

beforeEach(() => {
  vi.mocked(logPaymentEvent).mockClear();
  window.sessionStorage.clear();
  receiptByHash.clear();
  walletSends = [];
  // 接続の種類 (wagmi の connector の type) は、印の予約を解いてよいかの判定だけが読む。既定は injected (4001 がウォレット自身の答え)。
  useAccountMock.mockReturnValue({ address: CUSTOMER, connector: { type: 'injected' } });
  publicClientMock.getTransactionReceipt = vi.fn().mockRejectedValue(new Error('rpc receipt fetch failed'));
});

afterEach(async () => {
  for (const send of walletSends) {
    if (!send.settled) send.reject();
  }
  await waitFor(() => expect(outstandingRequest()).toBeNull());
});

// 印を渡さない送金の、外から見える全部。時刻 (issuedAt) と hash は決め打ち。利用料つき (PARAMS): merchant の送信 → 承認 →
// receipt → 利用料の送信 → 承認 → receipt → 成功、の各段の保存の intent と登録簿・ウォレットへの要求・writeContract の引数
// (abi は名前に置き換える)・決済のログ・結果。
// 前の記録の名残 (ウォレットへの要求・receipt・保存・ログ) を消して始める (1 つの test で 2 つ採るため)。
function freshRecord() {
  walletSends = [];
  receiptByHash.clear();
  window.sessionStorage.clear();
  vi.mocked(logPaymentEvent).mockClear();
}

async function offFlowRecord(send: (view: Screen) => void): Promise<Record<string, string>> {
  freshRecord();
  const tab = await makeTab();
  const view = await tab.mountScreen();
  const intent = () => window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY);
  const steps: Record<string, unknown> = {};
  atTime(SUBMITTED_AT, () => act(() => send(view)));
  await waitForWalletSends(1);
  steps.pending = { phase: view.result.current.phase, registry: outstandingRequest(), intent: intent() };
  await act(async () => {
    walletSends[0].approve(MERCHANT_TX);
  });
  await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
  steps.merchantSent = { registry: outstandingRequest(), intent: intent() };
  receiptByHash.set(MERCHANT_TX, receipt(MERCHANT_TX, 'success'));
  view.rerender();
  await waitForWalletSends(2);
  steps.feePrompt = { phase: view.result.current.phase, registry: outstandingRequest(), intent: intent() };
  await act(async () => {
    walletSends[1].approve(FEE_TX);
  });
  await waitFor(() => expect(loadStandardIntent()?.feeTxHash).toBe(FEE_TX));
  steps.feeSent = { registry: outstandingRequest(), intent: intent() };
  receiptByHash.set(FEE_TX, receipt(FEE_TX, 'success'));
  view.rerender();
  await waitFor(() => expect(view.result.current.phase).toBe('success'));
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
  steps.success = { intent: intent(), data: view.result.current.data, lastSubmittedParams: view.result.current.lastSubmittedParams };
  const record = {
    steps: jsonWithBigint(steps),
    wallet: jsonWithBigint(walletSends.map((w) => w.tx)),
    variables: jsonWithBigint(
      tab.mutationVariables().map((v) => ({ ...v, abi: v.abi === erc20Abi ? 'erc20Abi' : 'other' })),
    ),
    logged: loggedText(),
  };
  view.unmount();
  return record;
}

// 送信待ち (storage の読込の前に押した・利用料 0): ウォレットへの要求・writeContract の引数・承認の後の intent。
async function offQueuedRecord(send: (view: Screen) => void): Promise<Record<string, string>> {
  freshRecord();
  // 送信待ちは storage の読込の後の effect で送る (issuedAt はその時刻) ので、Date を通して固定する (timer は本物のまま)。
  vi.useFakeTimers({ toFake: ['Date'], now: SUBMITTED_AT });
  try {
    const tab = await makeTab();
    const view = tab.renderScreen();
    expect(view.result.current.isRestoring).toBe(true);
    act(() => send(view));
    await waitForWalletSends(1);
    await act(async () => {
      walletSends[0].approve(MERCHANT_TX);
    });
    await waitFor(() => expect(loadStandardIntent()?.merchantTxHash).toBe(MERCHANT_TX));
    const record = {
      wallet: jsonWithBigint(walletSends.map((w) => w.tx)),
      variables: jsonWithBigint(
        tab.mutationVariables().map((v) => ({ ...v, abi: v.abi === erc20Abi ? 'erc20Abi' : 'other' })),
      ),
      intent: String(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)),
    };
    view.unmount();
    return record;
  } finally {
    vi.useRealTimers();
  }
}

const capturePath = process.env.STD_BILL_MARK_GOLDEN_CAPTURE;
// 採る test は、環境変数があるときだけ定義する (普段の実行では登録しない = skipped として数えない)。
if (capturePath) {
  describe('GOLDEN を採る (main 956eb4ff の hook で走らせる)', () => {
    it('hook.json', async () => {
      const golden = {
        flow: await offFlowRecord((view) => view.result.current.mutate(PARAMS)),
        queued: await offQueuedRecord((view) => view.result.current.mutate(PARAMS_NO_FEE)),
      };
      writeFileSync(join(capturePath, 'hook.json'), `${JSON.stringify(golden, null, 2)}\n`);
    });
  });
}
const GOLDEN = goldenFromMain as { flow: Record<string, string>; queued: Record<string, string> };

describe('useStandardPayment の dataSuffix (K4b): 印を渡さない送金は main と 1 byte も変わらない', () => {
  it.each([
    ['mutate(params)', (view: Screen) => view.result.current.mutate(PARAMS)],
    ['mutate(params, undefined)', (view: Screen) => view.result.current.mutate(PARAMS, undefined)],
  ])('%s: 利用料つきの支払いの、ウォレットへの要求・writeContract の引数・保存の intent の各段・登録簿・決済のログ・結果が main の GOLDEN と同じ', async (_name, send) => {
    const record = await offFlowRecord(send);
    // 走査が中身を見ていることの確かめ。
    expect(record.wallet).toContain(MERCHANT_CALLDATA);
    expect(record.steps).toContain(MERCHANT_TX.slice(2));
    expect(record.logged).toContain(FEE_TX.slice(2));
    expect(record).toEqual(GOLDEN.flow);
  });

  it.each([
    ['mutate(params)', (view: Screen) => view.result.current.mutate(PARAMS_NO_FEE)],
    ['mutate(params, undefined)', (view: Screen) => view.result.current.mutate(PARAMS_NO_FEE, undefined)],
  ])('%s: 送信待ち (storage の読込の前に押した) も main の GOLDEN と同じ', async (_name, send) => {
    const record = await offQueuedRecord(send);
    expect(record.wallet).toContain(MERCHANT_CALLDATA);
    expect(record).toEqual(GOLDEN.queued);
  });

  it.each([
    ['mutate(params)', (view: Screen) => view.result.current.mutate(PARAMS_NO_FEE)],
    ['mutate(params, undefined)', (view: Screen) => view.result.current.mutate(PARAMS_NO_FEE, undefined)],
  ])('%s: ウォレットへは transfer の 68 byte・writeContract の引数に dataSuffix の key が無い', async (_name, send) => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => send(view));
    await waitForWalletSends(1);
    expect(walletSends[0].tx.to?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(walletSends[0].tx.data).toBe(MERCHANT_CALLDATA);
    expect(byteLength(walletSends[0].tx.data)).toBe(68);
    expect(Object.keys(tab.mutationVariables()[0])).toEqual(MAIN_VAR_KEYS);
    view.unmount();
  });

  it('送信待ち (storage の読込の前に押した) も、印を渡さなければ 68 byte', async () => {
    const tab = await makeTab();
    const view = tab.renderScreen();
    expect(view.result.current.isRestoring).toBe(true);
    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(1);
    expect(walletSends[0].tx.data).toBe(MERCHANT_CALLDATA);
    expect(Object.keys(tab.mutationVariables()[0])).toEqual(MAIN_VAR_KEYS);
    view.unmount();
  });
});

describe('useStandardPayment の dataSuffix (K4b): 印を渡した送金', () => {
  it('ウォレットへは transfer(受取先, 額) + 印 の 100 byte で、お店の端末の照合の calldata とちょうど同じ', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    const data = walletSends[0].tx.data;
    expect(data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    expect(byteLength(data)).toBe(100);
    // お店の端末 (lib/qrSaleHistory.ts) が同じ URL の会計から作る「transfer + 印」と同じで、お客様の EOA が JPYC へ直接
    // 送った tx として 1 と数える。
    expect(BILL.mark).toBe(MARK);
    expect(data).toBe(stdTransferCalldata(BILL));
    expect(
      stdMarkCount(
        { from: CUSTOMER, to: BILL.deployment.address, input: data! },
        { from: CUSTOMER, to: BILL.merchant, value: BILL.expected.value },
        BILL,
      ),
    ).toBe(1);
    // writeContract の引数は main の形 + dataSuffix だけ。
    expect(Object.keys(tab.mutationVariables()[0])).toEqual([...MAIN_VAR_KEYS, 'dataSuffix']);
    expect(tab.mutationVariables()[0].dataSuffix).toBe(MARK);
    view.unmount();
  });

  it('利用料の transfer には付けない (68 byte)・保存する intent は印なしの送金と同じ (印が入らない)', async () => {
    const run = async (mark: Hex | undefined) => {
      window.sessionStorage.clear();
      walletSends = [];
      receiptByHash.clear();
      const tab = await makeTab();
      const view = await tab.mountScreen();
      atTime(SUBMITTED_AT, () => act(() => view.result.current.mutate(PARAMS, mark)));
      await waitForWalletSends(1);
      await act(async () => {
        walletSends[0].approve(MERCHANT_TX);
      });
      await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
      const merchantIntent = window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY);
      receiptByHash.set(MERCHANT_TX, receipt(MERCHANT_TX, 'success'));
      view.rerender();
      await waitForWalletSends(2);
      const feeData = walletSends[1].tx.data;
      await act(async () => {
        walletSends[1].approve(FEE_TX);
      });
      await waitFor(() => expect(loadStandardIntent()?.feeTxHash).toBe(FEE_TX));
      const feeIntent = window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY);
      view.unmount();
      return { merchantData: walletSends[0].tx.data, feeData, merchantIntent, feeIntent, vars: tab.mutationVariables() };
    };
    const plain = await run(undefined);
    const marked = await run(MARK);
    expect(marked.merchantData).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    expect(plain.merchantData).toBe(MERCHANT_CALLDATA);
    expect(marked.feeData).toBe(FEE_CALLDATA);
    expect(plain.feeData).toBe(FEE_CALLDATA);
    expect(Object.keys(marked.vars[1])).toEqual(MAIN_VAR_KEYS);
    // 保存する intent (merchant・fee の段) は、印の有無で 1 byte も変わらない。
    expect(marked.merchantIntent).not.toBeNull();
    expect(marked.merchantIntent).toBe(plain.merchantIntent);
    expect(marked.feeIntent).toBe(plain.feeIntent);
    expect(marked.merchantIntent).not.toContain(MARK.slice(2));
    expect(marked.feeIntent).not.toContain(MARK.slice(2));
    // 決済のログ (成功の送金・利用料) に印は入らない (ログは params と hash だけ)。
    await waitFor(() => expect(vi.mocked(logPaymentEvent)).toHaveBeenCalled());
    expect(loggedText()).toContain(MERCHANT_TX.slice(2));
    expect(loggedText()).not.toContain(MARK.slice(2));
  });

  it('MUST-2: 送信待ち (storage の読込の前に押した) は、押した時の印を対で持ち、読込の後に印つきで送る', async () => {
    const tab = await makeTab();
    const view = tab.renderScreen();
    expect(view.result.current.isRestoring).toBe(true);
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    expect(walletSends[0].tx.data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    expect(walletSends).toHaveLength(1);
    view.unmount();
  });

  it('MUST-2: 登録簿は印つきの要求も 1 つの object で持つ: 出している間は載り、承認 (印の保存の後) と拒否で外れる', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    expect(outstandingRequest()).toBe('merchant');
    await act(async () => {
      walletSends[0].reject();
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    expect(outstandingRequest()).toBeNull();

    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    expect(outstandingRequest()).toBe('merchant');
    await act(async () => {
      walletSends[1].approve(MERCHANT_TX);
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
    // 後から spread した別の object を渡していたら、呼び出しごとの onSuccess の remove が外せず、ここで残る。
    expect(outstandingRequest()).toBeNull();
    expect(loadStandardIntent()).toMatchObject({ stage: 'merchant', merchantTxHash: MERCHANT_TX });
    expect(tab.mutationStatuses()).toEqual(['error', 'success']);
    view.unmount();
  });

  it('MUST-2: 確認中に画面を離れてから承認された印つきの送金も、印を保存し、開き直した画面は送り直さない', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    act(() => first.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    first.unmount();
    expect(loadStandardIntent()).toBeNull();
    walletSends[0].approve(MERCHANT_TX);
    // unmount の後の保存は「今の試みの vars === Mutation の variables」で見る (印つきでも同じ object)。
    await waitFor(() => expect(loadStandardIntent()).toMatchObject({ stage: 'merchant', merchantTxHash: MERCHANT_TX }));
    expect(outstandingRequest()).toBeNull();
    expect(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)).not.toContain(MARK.slice(2));

    const second = await tab.mountScreen();
    await waitFor(() => expect(second.result.current.phase).toBe('merchant-unknown'));
    act(() => second.result.current.mutate(PARAMS_NO_FEE, MARK));
    expect(walletSends).toHaveLength(1);
    second.unmount();
  });
});

// 置換 (同じ nonce の別の tx が mine された) の receipt。same = 同内容 (受取先への同じ Transfer がある = 高速化)・それ以外は
// 取消・別内容 (元の送金は mine されない)。
function replacedReceipt(minedHash: Hex, same: boolean): ReceiptState {
  const transfer = {
    address: TOKEN,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: CUSTOMER, to: BILL.merchant } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [BILL.expected.value]),
  };
  return {
    data: { status: 'success', blockNumber: 100n, transactionHash: minedHash, from: CUSTOMER, logs: same ? [transfer] : [] },
    error: null,
    isSuccess: true,
    isError: false,
    refetch: () => {},
  };
}

describe('useStandardPayment の dataSuffix (K4b・MUST-1): 印つきの送信が出たら (hash・拒否以外の失敗)、その画面の以後の送信は印なし', () => {
  // 1 本目を送り、settle で結果を出して、同じ画面からもう一度送れる状態 (phase = waitPhase) にし、印つきでもう一度送る。
  // 2 本目のウォレットへの calldata を返す。firstMark = 1 本目に渡す印 (null = 渡さない)。
  async function settleThenResend(
    settle: (view: Screen) => Promise<void>,
    waitPhase: string,
    firstMark: Hex | null = MARK,
  ) {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, firstMark ?? undefined));
    await waitForWalletSends(1);
    await settle(view);
    await waitFor(() => expect(view.result.current.phase).toBe(waitPhase));
    const error = view.result.current.error;
    const settledError = errorTexts(error);
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    const second = walletSends[1].tx.data;
    view.unmount();
    return { first: walletSends[0].tx.data, second, settledError, error };
  }
  // 1 本目のウォレット (provider) が、決めた error を投げる。
  const rejectFirstWith = (make: () => unknown) => async () => {
    await act(async () => {
      walletSends[0].rejectWith(make());
    });
  };
  // 1 本目のウォレットが hash を返し、mine を待つ所まで。
  async function approveFirst(view: Screen) {
    await act(async () => {
      walletSends[0].approve(MERCHANT_TX);
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
  }
  async function failFirst() {
    await act(async () => {
      walletSends[0].fail();
    });
  }
  async function settleReceipt(view: Screen, state: ReceiptState) {
    await approveFirst(view);
    receiptByHash.set(MERCHANT_TX, state);
    view.rerender();
  }

  it('hash の返らない送信の失敗 (ウォレットの拒否でない) → 次は今までどおりの transfer (68 byte)', async () => {
    const out = await settleThenResend(failFirst, 'merchant-error');
    expect(byteLength(out.first)).toBe(100);
    expect(out.second).toBe(MERCHANT_CALLDATA);
    expect(byteLength(out.second)).toBe(68);
    // 送信の失敗の error (画面・決済のログ・Sentry に渡る文と cause の連なり) に印は入らない (viem の error は印を足す前の data を出す)。
    expect(out.settledError).toContain('Internal JSON-RPC error');
    // cause の連なりの Request Arguments の data は、印を足す前の transfer の 68 byte (行の終わりまで)。
    expect(out.settledError).toMatch(new RegExp(`data:\\s+${MERCHANT_CALLDATA}\\n`));
    expect(out.settledError).not.toContain(MARK.slice(2));
    await waitFor(() => expect(loggedText()).toContain('Internal JSON-RPC error'));
    expect(loggedText()).not.toContain(MARK.slice(2));
  });

  // 印つきの送信が hash を返した (チェーンに出た) 後は、その結果を追わずに次は印なし。mine を待っている間 (保存の印がある間) は、
  // 今までどおり送り直せない (二重払いの止め)。
  const AFTER_HASH: [string, (view: Screen) => Promise<void>, string][] = [
    ['成功 (receipt の success)', (view) => settleReceipt(view, receipt(MERCHANT_TX, 'success')), 'success'],
    ['revert の確定 (receipt が reverted)', (view) => settleReceipt(view, receipt(MERCHANT_TX, 'reverted')), 'merchant-error'],
    [
      'revert の確定 (receipt の照会の error の後、生の receipt で reverted を確かめた)',
      async (view) => {
        publicClientMock.getTransactionReceipt = vi.fn().mockResolvedValue({ status: 'reverted' });
        await settleReceipt(view, { ...NO_RECEIPT, error: new Error('execution reverted'), isError: true });
      },
      'merchant-error',
    ],
    ['同内容の置換 (高速化) の成功', (view) => settleReceipt(view, replacedReceipt(NEXT_TX, true)), 'success'],
    ['取消・別内容の取引への置換', (view) => settleReceipt(view, replacedReceipt(NEXT_TX, false)), 'merchant-error'],
  ];
  it.each(AFTER_HASH)('印つきの送信が hash を返した後: %s → 次は 68 byte', async (_name, settle, waitPhase) => {
    const out = await settleThenResend(settle, waitPhase);
    expect(byteLength(out.first)).toBe(100);
    expect(out.second).toBe(MERCHANT_CALLDATA);
  });

  it('ウォレットでの拒否 (EIP-1193 の 4001・tx が出ない・お客様が自分で取り消した) は数えない → 次も印つき (100 byte)', async () => {
    const out = await settleThenResend(async () => {
      await act(async () => {
        walletSends[0].reject();
      });
    }, 'merchant-error');
    // 4001 は、viem・wagmi が包んだ error の cause の奥に届く (画面に渡る error 自身に code は無い)。
    expect(errorChain(out.error)).toEqual([
      { name: 'ContractFunctionExecutionError', code: undefined },
      { name: 'TransactionExecutionError', code: undefined },
      { name: 'UserRejectedRequestError', code: 4001 },
      { name: 'Error', code: 4001 },
    ]);
    expect(out.second).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    expect(byteLength(out.second)).toBe(100);
  });

  it('ウォレットが Error でない object の 4001 を投げても (WalletConnect の応答の形) → 予約を解き、次も印つき (100 byte)', async () => {
    const out = await settleThenResend(
      rejectFirstWith(() => ({ code: 4001, message: 'User rejected the request.' })),
      'merchant-error',
    );
    expect(errorChain(out.error).map(({ code }) => code)).toEqual([undefined, undefined, 4001, 4001]);
    expect(out.second).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
  });

  it('ウォレットが投げた error 自身に code が無いと、その cause の奥に 4001 があっても解かない (viem は UnknownRpcError に包む) → 68 byte', async () => {
    const out = await settleThenResend(
      rejectFirstWith(
        () => new Error('Request failed', { cause: Object.assign(new Error('User rejected the request.'), { code: 4001 }) }),
      ),
      'merchant-error',
    );
    expect(errorChain(out.error)).toEqual([
      { name: 'ContractFunctionExecutionError', code: undefined },
      { name: 'TransactionExecutionError', code: undefined },
      { name: 'UnknownRpcError', code: -1 },
      { name: 'Error', code: undefined },
      { name: 'Error', code: 4001 },
    ]);
    expect(out.second).toBe(MERCHANT_CALLDATA);
  });

  // Codex のレビュー (MUST 4 回目): 予約を解くのは、ウォレットが EIP-1193 の 4001 で答えたと、元の error の code で確かめられたときだけ。
  // 文言だけの「拒否」(lib/walletErrors の isUserRejection = 計測・表示用の判定は真にする) は、ウォレットが tx を出した後に
  // hash の応答だけが失われたのかもしれないので、予約のまま (印を渡して送り直しても 68 byte = 同じ画面から印つきが 2 本出ない)。
  it.each<[string, () => unknown]>([
    ['code の無い Connection request reset', () => new Error('Connection request reset. Please try again.')],
    ['code の無い User rejected the request.', () => new Error('User rejected the request.')],
    ['code の無い User denied transaction signature', () => new Error('MetaMask Tx Signature: User denied transaction signature.')],
    ["code が文字列の '4001'", () => Object.assign(new Error('User rejected the request.'), { code: '4001' })],
    [
      '4001 のさらに奥に別の code の error がある',
      () =>
        Object.assign(new Error('User rejected the request.'), {
          code: 4001,
          cause: Object.assign(new Error('socket closed'), { code: -32000 }),
        }),
    ],
    [
      '4001 のさらに奥に code の無い error がある (包む側が文言から作った 4001 の形)',
      () =>
        Object.assign(new Error('User rejected the request.'), {
          code: 4001,
          cause: new Error('Connection request reset. Please try again.'),
        }),
    ],
  ])('4001 と確かめられない「拒否」(%s) の後は、印を渡して送り直しても 68 byte', async (_name, make) => {
    const out = await settleThenResend(rejectFirstWith(make), 'merchant-error');
    expect(byteLength(out.first)).toBe(100);
    // 文言での判定は拒否と見る (この判定で予約を解くと、次も 100 byte になる)。
    expect(isUserRejection(out.error)).toBe(true);
    expect(out.second).toBe(MERCHANT_CALLDATA);
    expect(byteLength(out.second)).toBe(68);
  });

  it('WalletConnect の 5000 は、viem が UserRejectedRequestError (code 4001) に包むが、元の code は 4001 でない → 68 byte', async () => {
    const out = await settleThenResend(
      rejectFirstWith(() => Object.assign(new Error('User rejected.'), { code: 5000 })),
      'merchant-error',
    );
    expect(errorChain(out.error)).toEqual([
      { name: 'ContractFunctionExecutionError', code: undefined },
      { name: 'TransactionExecutionError', code: undefined },
      { name: 'UserRejectedRequestError', code: 4001 },
      { name: 'Error', code: 5000 },
    ]);
    expect(isUserRejection(out.error)).toBe(true);
    expect(out.second).toBe(MERCHANT_CALLDATA);
  });

  // 4001 がウォレット自身の答えである接続 (injected・WalletConnect) のときだけ、4001 で予約を解く。Coinbase Wallet SDK は、popup が
  // 閉じただけで SDK が 4001 を作る (承認の後に閉じると、tx が出ていても 4001 が届きうる) ので解かない。知らない接続も解かない。
  it.each<[string, number, { type: string } | undefined]>([
    ['WalletConnect', 100, { type: 'walletConnect' }],
    ['Coinbase Wallet SDK', 68, { type: 'coinbaseWallet' }],
    ['知らない接続', 68, { type: 'mock' }],
    ['接続を読めない', 68, undefined],
  ])('接続が %s のときの 4001 の後に、印を渡して送り直すと %d byte', async (_name, bytes, connector) => {
    useAccountMock.mockReturnValue({ address: CUSTOMER, connector });
    const out = await settleThenResend(async () => {
      await act(async () => {
        walletSends[0].reject();
      });
    }, 'merchant-error');
    expect(byteLength(out.first)).toBe(100);
    expect(byteLength(out.second)).toBe(bytes);
  });

  it('予約を解いてよい接続かは、印つきで送ったときの接続で決まる (応答待ちの間に接続が変わっても)', async () => {
    useAccountMock.mockReturnValue({ address: CUSTOMER, connector: { type: 'coinbaseWallet' } });
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    useAccountMock.mockReturnValue({ address: CUSTOMER, connector: { type: 'injected' } });
    view.rerender();
    await act(async () => {
      walletSends[0].reject();
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    expect(walletSends[1].tx.data).toBe(MERCHANT_CALLDATA);
    view.unmount();
  });

  const UNMARKED: [string, (view: Screen) => Promise<void>, string][] = [
    ['拒否以外の失敗', failFirst, 'merchant-error'],
    ['hash を返して成功', (view) => settleReceipt(view, receipt(MERCHANT_TX, 'success')), 'success'],
    ['hash を返して revert', (view) => settleReceipt(view, receipt(MERCHANT_TX, 'reverted')), 'merchant-error'],
  ];
  it.each(UNMARKED)('印なしの送信の結果は数えない (%s) → 次の印つきの送信は印つき', async (_name, settle, waitPhase) => {
    const out = await settleThenResend(settle, waitPhase, null);
    expect(out.first).toBe(MERCHANT_CALLDATA);
    expect(out.second).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
  });

  // Codex のレビュー (MUST 3 回): 同じ画面で印つき A の応答待ちの間に B を始めると、reset で wagmi の見ている先が A から外れ、
  // A の結果 (失敗・hash) は画面の state にも receipt の見張りにも入らない。また A の hash が返る前は、B に印を渡すと印つきが 2 本
  // 出うる。印つきで送る直前に同期で予約するので、A の応答待ちの間の B は印を渡しても印なし。予約を解くのは、送信自身の variables
  // を見る hook の options の onError が、A のウォレットの拒否を見たときだけ。
  it.each([
    ['A の失敗 (拒否でない)', () => walletSends[0].fail()],
    ['A の hash (チェーンに出た)', () => walletSends[0].approve(MERCHANT_TX)],
  ])('印つき A の応答待ちの間に B を印つきで始めると B は印なし。%s が B の開始の後に届き、B は拒否 → 次の C も 68 byte', async (_name, resolveA) => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    // A の応答の前に、B はもう印なし (同じ画面で印つきが 2 本出ない)。
    expect(walletSends[1].tx.data).toBe(MERCHANT_CALLDATA);
    await act(async () => {
      resolveA();
    });
    await waitFor(() => expect(tab.mutationStatuses()[0]).not.toBe('pending'));
    await act(async () => {
      walletSends[1].reject();
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(3);
    expect(walletSends[0].tx.data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    expect(walletSends[2].tx.data).toBe(MERCHANT_CALLDATA);
    view.unmount();
  });

  it('印つき A の応答待ちの間の B は印なし。A がウォレットの拒否で後から解決したら予約を解き、B の後の C は印つきに戻る', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    expect(walletSends[1].tx.data).toBe(MERCHANT_CALLDATA);
    await act(async () => {
      walletSends[0].reject();
    });
    await act(async () => {
      walletSends[1].reject();
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(3);
    expect(walletSends[2].tx.data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    view.unmount();
  });

  it('印つき A の拒否の後の送信は、印なしの B がまだ応答待ちでも印つき (出ている印つきは無い)・その次は印なし', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    await act(async () => {
      walletSends[0].reject();
    });
    await waitFor(() => expect(tab.mutationStatuses()[0]).toBe('error'));
    // B (印なし) はまだウォレットに出たまま。A の拒否で予約が解けたので、次の送信は印つき。
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(3);
    expect(walletSends[1].tx.data).toBe(MERCHANT_CALLDATA);
    expect(walletSends[2].tx.data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    // その応答待ちの間の送信は、また印なし。
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(4);
    expect(walletSends[3].tx.data).toBe(MERCHANT_CALLDATA);
    view.unmount();
  });

  it('印なしに戻すのは、その画面だけ (開き直した画面は印つきで送る・そこで出たら次は印なし)', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    act(() => first.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    await act(async () => {
      walletSends[0].fail();
    });
    await waitFor(() => expect(first.result.current.phase).toBe('merchant-error'));
    first.unmount();

    const second = await tab.mountScreen();
    act(() => second.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    expect(walletSends[1].tx.data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    await act(async () => {
      walletSends[1].approve(MERCHANT_TX);
    });
    receiptByHash.set(MERCHANT_TX, receipt(MERCHANT_TX, 'success'));
    second.rerender();
    await waitFor(() => expect(second.result.current.phase).toBe('success'));
    act(() => second.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(3);
    expect(walletSends[2].tx.data).toBe(MERCHANT_CALLDATA);
    await act(async () => {
      walletSends[2].approve(NEXT_TX);
    });
    second.unmount();
  });
});
