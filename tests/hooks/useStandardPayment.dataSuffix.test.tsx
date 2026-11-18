import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  concatHex,
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
import { jsonWithBigint } from '../_helpers/relayAttemptCapture';

// K4b: 通常決済の hook (useStandardPayment) の mutate の第 2 引数 dataSuffix (会計の印) が、ウォレットへ送る calldata に
// どう載るか。wagmi の useWriteContract は本物のまま (本物の @wagmi/core の writeContract・viem・TanStack Query の Mutation)。
// mock は境界だけ: ウォレット (EIP-1193 の request = 承認・拒否・失敗まで止めておける promise) と、receipt の照会。
//   - dataSuffix を渡さない送金 (試しのスイッチ OFF・ほかの全員) は main と同じ: ウォレットへは transfer の 68 byte・
//     writeContract の引数の object に dataSuffix の key が無い。
//   - 渡した送金は transfer(受取先, 額) + 印 の 100 byte で、お店の端末の照合 (lib/qrSaleHistory.ts) の calldata と同じ。
//   - 利用料の transfer・保存する intent には印が無い。
//   - MUST-2: 印は writeContract に渡す 1 つの object の中 (登録簿と unmount の後の保存は object の同一性で見る)・送信待ちも対。
//   - MUST-1: 印つきの送信が確定して失敗したら (ウォレットの拒否を除く)、その画面の以後の送信は印なし。
// 兄弟の useStandardPayment.unmount.test.tsx と同じ形の harness (この file の分だけを写した)。
type ReceiptState = {
  data: { status: 'success' | 'reverted'; blockNumber: bigint; transactionHash: Hex; from: Address; logs: [] } | undefined;
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
  useAccountMock.mockReturnValue({ address: CUSTOMER });
  publicClientMock.getTransactionReceipt = vi.fn().mockRejectedValue(new Error('rpc receipt fetch failed'));
});

afterEach(async () => {
  for (const send of walletSends) {
    if (!send.settled) send.reject();
  }
  await waitFor(() => expect(outstandingRequest()).toBeNull());
});

describe('useStandardPayment の dataSuffix (K4b): 印を渡さない送金は main と 1 byte も変わらない', () => {
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

describe('useStandardPayment の dataSuffix (K4b・MUST-1): 印つきの送信が確定して失敗したら、その画面の以後の送信は印なし', () => {
  // 印つきで送り、失敗させ (fail)、同じ画面から印つきでもう一度送る。2 本目のウォレットへの calldata を返す。
  // firstMark = 1 本目に渡す印 (null = 渡さない)。
  async function failThenResend(fail: (view: Screen) => Promise<void>, firstMark: Hex | null = MARK) {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, firstMark ?? undefined));
    await waitForWalletSends(1);
    await fail(view);
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    const failedError = errorTexts(view.result.current.error);
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(2);
    const second = walletSends[1].tx.data;
    view.unmount();
    return { first: walletSends[0].tx.data, second, failedError };
  }

  it('hash の返らない送信の失敗 (ユーザーの拒否でない) → 次は今までどおりの transfer (68 byte)', async () => {
    const out = await failThenResend(async () => {
      await act(async () => {
        walletSends[0].fail();
      });
    });
    expect(byteLength(out.first)).toBe(100);
    expect(out.second).toBe(MERCHANT_CALLDATA);
    expect(byteLength(out.second)).toBe(68);
    // 送信の失敗の error (画面・決済のログ・Sentry に渡る文と cause の連なり) に印は入らない (viem の error は印を足す前の data を出す)。
    expect(out.failedError).toContain('Internal JSON-RPC error');
    // cause の連なりの Request Arguments の data は、印を足す前の transfer の 68 byte (行の終わりまで)。
    expect(out.failedError).toMatch(new RegExp(`data:\\s+${MERCHANT_CALLDATA}\\n`));
    expect(out.failedError).not.toContain(MARK.slice(2));
    await waitFor(() => expect(loggedText()).toContain('Internal JSON-RPC error'));
    expect(loggedText()).not.toContain(MARK.slice(2));
  });

  it('revert の確定 (receipt が reverted) → 次は 68 byte', async () => {
    const out = await failThenResend(async (view) => {
      await act(async () => {
        walletSends[0].approve(MERCHANT_TX);
      });
      await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
      receiptByHash.set(MERCHANT_TX, receipt(MERCHANT_TX, 'reverted'));
      view.rerender();
    });
    expect(byteLength(out.first)).toBe(100);
    expect(out.second).toBe(MERCHANT_CALLDATA);
  });

  it('revert の確定 (receipt の照会の error の後、生の receipt で reverted を確かめた) → 次は 68 byte', async () => {
    const out = await failThenResend(async (view) => {
      await act(async () => {
        walletSends[0].approve(MERCHANT_TX);
      });
      await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
      publicClientMock.getTransactionReceipt = vi.fn().mockResolvedValue({ status: 'reverted' });
      receiptByHash.set(MERCHANT_TX, { ...NO_RECEIPT, error: new Error('execution reverted'), isError: true });
      view.rerender();
    });
    expect(out.second).toBe(MERCHANT_CALLDATA);
  });

  it('ウォレットでの拒否 (お客様が自分で取り消した) は失敗に数えない → 次も印つき (100 byte)', async () => {
    const out = await failThenResend(async () => {
      await act(async () => {
        walletSends[0].reject();
      });
    });
    expect(out.second).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
  });

  it('印なしの送信の失敗は数えない → 次の印つきの送信は印つき', async () => {
    const out = await failThenResend(async () => {
      await act(async () => {
        walletSends[0].fail();
      });
    }, null);
    expect(out.first).toBe(MERCHANT_CALLDATA);
    expect(out.second).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
  });

  it('印なしに戻すのは、その画面だけ (開き直した画面は印つきで送る)・成功した印つきの送信は数えない', async () => {
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
    // 成功の後の次の支払い (同じ画面) も印つき。
    act(() => second.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(3);
    expect(walletSends[2].tx.data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    await act(async () => {
      walletSends[2].approve(NEXT_TX);
    });
    second.unmount();
  });

  // Codex のレビュー (MUST): 同じ画面で印つき A の応答待ちの間に B を始めると、reset で wagmi の見ている先が A から外れる。A の
  // 失敗はその後で届くので、画面の state (merchantWrite.error) には出ない。失敗した送信自身の variables で数える。
  it('印つき A の応答待ちの間に印なし B を始め、A の失敗 (拒否でない) が B の開始の後に届く → A の失敗を数える (次の C は 68 byte)', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(2);
    await act(async () => {
      walletSends[0].fail();
    });
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['error', 'pending']));
    await act(async () => {
      walletSends[1].reject();
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(3);
    expect(walletSends[0].tx.data).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
    expect(walletSends[1].tx.data).toBe(MERCHANT_CALLDATA);
    expect(walletSends[2].tx.data).toBe(MERCHANT_CALLDATA);
    view.unmount();
  });

  it('印つき A の応答待ちの間に B を始め、A がウォレットの拒否で後から解決しても数えない (次の C は印つき)', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE, MARK));
    await waitForWalletSends(1);
    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(2);
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

  // revert は「印を付けて送った hash」に結び付けて数える (今の試みの印の有無では見ない)。
  it('印なしで送った hash の revert は数えない (次の印つきの送信は印つき)', async () => {
    const out = await failThenResend(async (view) => {
      await act(async () => {
        walletSends[0].approve(MERCHANT_TX);
      });
      await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
      receiptByHash.set(MERCHANT_TX, receipt(MERCHANT_TX, 'reverted'));
      view.rerender();
    }, null);
    expect(out.first).toBe(MERCHANT_CALLDATA);
    expect(out.second).toBe(concatHex([MERCHANT_CALLDATA, MARK]));
  });
});
