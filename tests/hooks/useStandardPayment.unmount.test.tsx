import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  encodeFunctionData,
  erc20Abi,
  numberToHex,
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
import {
  STANDARD_INTENT_STORAGE_KEY,
  loadStandardIntent,
} from '@/lib/paymentIntentStorage';
import { standardWalletRequestElsewhere } from '@/lib/standardPaymentOutstanding';

// H-D (第 10 回レビュー): ウォレットの確認が出ている間に画面を離れてから承認された送金の、復旧の印。
//
// 兄弟の useStandardPayment.test.tsx は useWriteContract を丸ごと mock し、test が onSuccess を手で呼ぶ。その形では
// 「unmount した observer の呼び出しごとの callback は呼ばれない」という TanStack Query の性質を通らない。
// この file は wagmi の useWriteContract を本物のまま使う (本物の @wagmi/core の writeContract・viem・TanStack Query の
// Mutation)。mock は境界だけ: ウォレット (EIP-1193 の request = 承認まで止めておける promise) と、receipt の照会。
type MockReceipt = {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionHash: Hex;
  from: Address;
  logs: [];
};
type ReceiptState = {
  data: MockReceipt | undefined;
  error: Error | null;
  isSuccess: boolean;
  isError: boolean;
  refetch: () => void;
};
const NO_RECEIPT: ReceiptState = {
  data: undefined,
  error: null,
  isSuccess: false,
  isError: false,
  refetch: () => {},
};
// hash ごとの receipt (置かなければ未確定)。
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

// paymentLog は fire-and-forget で外部 HTTP を打つ (兄弟 test と同じ境界)。
vi.mock('@/lib/paymentLog', () => ({
  logPaymentEvent: vi.fn(),
  buildPaymentLogEvent: (ctx: object, outcome: object) => ({ ...ctx, ...outcome }),
}));

import {
  useStandardPayment,
  type StandardPaymentParams,
} from '@/hooks/useStandardPayment';

const CHAIN_ID = baseSepolia.id;
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const FEE_RECEIVER: Address = '0xdead000000000000000000000000000000001234';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const MERCHANT_TX: Hex = `0x${'a'.repeat(64)}`;
const FEE_TX: Hex = `0x${'b'.repeat(64)}`;
const OLD_MERCHANT_TX: Hex = `0x${'c'.repeat(64)}`;
const OLD_FEE_TX: Hex = `0x${'d'.repeat(64)}`;
const CONTEXT_KEY: Hex = `0x${'1'.repeat(64)}`;
const ORDER_LINK_KEY: Hex = `0x${'2'.repeat(64)}`;

const PARAMS: StandardPaymentParams = {
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  merchantAmount: 9_950_000n,
  feeReceiver: FEE_RECEIVER,
  feeAmount: 50_000n,
  saleAmount: 10_000_000n,
  chainId: CHAIN_ID,
  contextKey: CONTEXT_KEY,
  orderLinkKey: ORDER_LINK_KEY,
};
const PARAMS_NO_FEE: StandardPaymentParams = { ...PARAMS, feeAmount: 0n };

const MERCHANT_CALLDATA = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'transfer',
  args: [MERCHANT, PARAMS.merchantAmount],
});
const FEE_CALLDATA = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'transfer',
  args: [FEE_RECEIVER, PARAMS.feeAmount],
});

// ウォレットに届いた送金の要求 (eth_sendTransaction)。承認 = approve(hash)・拒否 = reject() を呼ぶまで止まる。
type WalletSend = {
  tx: { to?: string; data?: string; from?: string };
  approve: (hash: Hex) => void;
  reject: () => void;
  settled: boolean;
};
let walletSends: WalletSend[] = [];

function walletRequest({
  method,
  params,
}: {
  method: string;
  params?: unknown;
}): Promise<unknown> {
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
        settled: false,
      };
      walletSends.push(send);
    });
  }
  return Promise.reject(new Error(`unexpected wallet method: ${method}`));
}

// 登録簿 (lib/standardPaymentOutstanding) を、どの hook でもない持ち主から見る = 出したままの要求があるか。
const NO_HOOK = {};
const outstandingRequest = () => standardWalletRequestElsewhere(NO_HOOK);

// 送信した時刻 (mutate の時刻) を固定する。承認・利用料の送信はこれと違う時刻に起こし、印の issuedAt が送信した時刻の
// ままかを確かめる。
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
  // connect の戻り値の型は withCapabilities の generic に依る。ここでは address の配列だけを返す。
  connect: (async () => ({
    accounts: [CUSTOMER],
    chainId: CHAIN_ID,
  })) as never,
  disconnect: async () => {},
  getAccounts: async () => [CUSTOMER],
  getChainId: async () => CHAIN_ID,
  getProvider: async () => ({ request: walletRequest }),
  isAuthorized: async () => true,
  onAccountsChanged: () => {},
  onChainChanged: () => {},
  onDisconnect: () => {},
}));

// 1 つの「タブ」: 同じ wagmi の config と同じ QueryClient の下で、画面 (hook) を mount し直す。
async function makeTab() {
  const config = createConfig({
    chains: [baseSepolia],
    connectors: [testWallet],
    multiInjectedProviderDiscovery: false,
    storage: null,
    // receipt と public client は mock なので、この transport は使われない。
    transports: { [baseSepolia.id]: http('http://127.0.0.1:9') },
  });
  await connect(config, { connector: config.connectors[0] });
  // lib/wagmi.ts が Register で本番の config の型を登録しているので、test 用の config (chain 1 つ) は型だけ合わせる。
  const providerConfig = config as unknown as ResolvedRegister['config'];
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <WagmiProvider config={providerConfig} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    );
  }
  async function mountScreen(options: { reactStrictMode?: boolean } = {}) {
    const view = renderHook(() => useStandardPayment(), {
      wrapper: Wrapper,
      ...options,
    });
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    return view;
  }
  // 作った順の mutation の状態 (unmount の後も Mutation は cache に残り、最後まで走る)。
  const mutationStatuses = () =>
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.status);
  return { mountScreen, mutationStatuses, Wrapper };
}

function minedReceipt(hash: Hex, blockNumber: bigint): ReceiptState {
  return {
    data: {
      status: 'success',
      blockNumber,
      transactionHash: hash,
      from: CUSTOMER,
      logs: [],
    },
    error: null,
    isSuccess: true,
    isError: false,
    refetch: () => {},
  };
}

// 復旧の印を保存した回数 (stage ごと)。「mount 中は二重に書かない」を数で確かめる。
let intentWrites: string[] = [];
// spy を掛ける前の実物 (beforeEach のたびに spy 済みの setItem を掴むと、自分自身を呼び続ける)。
const realSetItem = Storage.prototype.setItem;

beforeEach(() => {
  window.sessionStorage.clear();
  receiptByHash.clear();
  walletSends = [];
  intentWrites = [];
  useAccountMock.mockReturnValue({ address: CUSTOMER });
  publicClientMock.getTransactionReceipt = vi
    .fn()
    .mockRejectedValue(new Error('rpc receipt fetch failed'));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === STANDARD_INTENT_STORAGE_KEY) {
      intentWrites.push((JSON.parse(value) as { stage: string }).stage);
    }
    realSetItem.call(this, key, value);
  });
});

// 登録簿は module の範囲 (この file の test で共有) なので、test の終わりにウォレットに残った要求を拒否で解決し、
// 登録簿が空になってから次の test へ進む (残した要求で次の test の支払いが止まらないように)。
afterEach(async () => {
  for (const send of walletSends) {
    if (!send.settled) send.reject();
  }
  await waitFor(() => expect(outstandingRequest()).toBeNull());
});

async function waitForWalletSends(count: number) {
  await waitFor(() => expect(walletSends).toHaveLength(count));
}

// merchant を送って mine まで進め、fee の確認がウォレットに出ている所まで (fee の要求は walletSends[1])。
// submittedAt を渡すと、その時刻に送信する (mutate の間だけ Date.now を固定する)。
async function advanceToFeePrompt(
  view: Awaited<ReturnType<Awaited<ReturnType<typeof makeTab>>['mountScreen']>>,
  submittedAt?: number,
) {
  if (submittedAt === undefined) {
    act(() => view.result.current.mutate(PARAMS));
  } else {
    atTime(submittedAt, () => act(() => view.result.current.mutate(PARAMS)));
  }
  await waitForWalletSends(1);
  await act(async () => {
    walletSends[0].approve(MERCHANT_TX);
  });
  await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
  receiptByHash.set(MERCHANT_TX, minedReceipt(MERCHANT_TX, 100n));
  view.rerender();
  await waitForWalletSends(2);
  expect(view.result.current.phase).toBe('fee-sending');
  expect(loadStandardIntent()).toMatchObject({
    stage: 'fee-awaiting',
    merchantTxHash: MERCHANT_TX,
    merchantBlockNumber: '100',
  });
  expect(loadStandardIntent()?.feeTxHash).toBeUndefined();
}

describe('useStandardPayment: ウォレットの確認中に画面を離れた送金の復旧の印 (H-D)', () => {
  it('前提: ウォレットに届くのは本物の ERC-20 transfer の要求で、mount 中に承認されると印は 1 回だけ書かれる', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(1);
    expect(walletSends[0].tx.to?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(walletSends[0].tx.data).toBe(MERCHANT_CALLDATA);
    expect(walletSends[0].tx.from?.toLowerCase()).toBe(CUSTOMER.toLowerCase());
    expect(loadStandardIntent()).toBeNull();

    await act(async () => {
      walletSends[0].approve(MERCHANT_TX);
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
    expect(tab.mutationStatuses()).toEqual(['success']);
    // hook の options の onSuccess と呼び出しごとの onSuccess の両方が走るが、書くのは呼び出しごとの側だけ。
    expect(intentWrites).toEqual(['merchant']);
    expect(loadStandardIntent()).toMatchObject({
      stage: 'merchant',
      merchantTxHash: MERCHANT_TX,
    });
    view.unmount();
  });

  it('merchant: 確認中に画面を離れてから承認されても印が残り、開き直した画面は merchant-unknown で送り直さない', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    atTime(SUBMITTED_AT, () => act(() => first.result.current.mutate(PARAMS)));
    await waitForWalletSends(1);
    expect(first.result.current.phase).toBe('merchant-sending');

    // ウォレットの確認が出ている間に画面を離れる (/pay のヘッダの Link・言語の切り替え・accordion を閉じる)。
    first.unmount();
    expect(loadStandardIntent()).toBeNull();

    // その後で (10 分遅れて) ウォレットが承認する = 送金は broadcast される。印の issuedAt は承認の時刻でなく送信した時刻。
    const approvedLater = vi.spyOn(Date, 'now').mockReturnValue(SUBMITTED_AT + 10 * 60_000);
    walletSends[0].approve(MERCHANT_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success']));
    approvedLater.mockRestore();
    expect(intentWrites).toEqual(['merchant']);
    expect(loadStandardIntent()).toEqual({
      version: 1,
      chainId: CHAIN_ID,
      from: CUSTOMER,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantValue: '9950000',
      feeReceiver: FEE_RECEIVER,
      feeValue: '50000',
      saleValue: '10000000',
      stage: 'merchant',
      merchantTxHash: MERCHANT_TX,
      contextKey: CONTEXT_KEY,
      orderLinkKey: ORDER_LINK_KEY,
      issuedAt: SUBMITTED_AT,
    });

    // 開き直した画面 (新しい hook) は印を読み、同じ送金をもう一度ウォレットへ出さない。
    const second = await tab.mountScreen();
    await waitFor(() => expect(second.result.current.phase).toBe('merchant-unknown'));
    expect(second.result.current.hasActiveIntent).toBe(true);
    expect(second.result.current.restoredFromStorage).toBe(true);
    expect(second.result.current.merchantTxHash).toBe(MERCHANT_TX);
    act(() => second.result.current.mutate(PARAMS));
    act(() => second.result.current.retryFee());
    // 「2 本目が無い」は待ち時間でなく、mutation が 1 本目だけのまま増えていないことで確かめる。
    expect(tab.mutationStatuses()).toEqual(['success']);
    expect(walletSends).toHaveLength(1);
    expect(second.result.current.phase).toBe('merchant-unknown');
    second.unmount();
  });

  it('merchant: reset で捨てた古い試みが、画面を離れた後に承認されても保存しない (今の試みだけ保存する)', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    act(() => view.result.current.mutate(PARAMS));
    await waitForWalletSends(1);
    // 同じ画面からの送り直し (reset → 新しい試み)。古い要求はウォレットに残ったまま。
    act(() => view.result.current.mutate(PARAMS));
    await waitForWalletSends(2);
    view.unmount();

    walletSends[0].approve(OLD_MERCHANT_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success', 'pending']));
    expect(intentWrites).toEqual([]);
    expect(loadStandardIntent()).toBeNull();

    walletSends[1].approve(MERCHANT_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success', 'success']));
    expect(intentWrites).toEqual(['merchant']);
    expect(loadStandardIntent()).toMatchObject({
      stage: 'merchant',
      merchantTxHash: MERCHANT_TX,
    });
  });

  it('StrictMode の mount→unmount→mount の後は mount 中として扱う (承認で印は 1 回だけ・本当に離れた後は書く)', async () => {
    const tab = await makeTab();
    const effectRuns: string[] = [];
    // wrapper の中の <StrictMode> は効果を二重にしない。renderHook の reactStrictMode を使い、同じ component に置いた
    // 見張りの effect で、hook の mount の effect (mountedRef を true に戻す) も二重に走ったことを確かめる。
    const view = renderHook(
      () => {
        useEffect(() => {
          effectRuns.push('mount');
          return () => {
            effectRuns.push('unmount');
          };
        }, []);
        return useStandardPayment();
      },
      { wrapper: tab.Wrapper, reactStrictMode: true },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    expect(effectRuns).toEqual(['mount', 'unmount', 'mount']);

    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(1);
    await act(async () => {
      walletSends[0].approve(OLD_MERCHANT_TX);
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
    expect(intentWrites).toEqual(['merchant']);

    // 次の試みは、本当に画面を離れた後に承認される。
    receiptByHash.set(OLD_MERCHANT_TX, {
      ...minedReceipt(OLD_MERCHANT_TX, 90n),
      data: { ...minedReceipt(OLD_MERCHANT_TX, 90n).data!, status: 'reverted' },
    });
    view.rerender();
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    expect(loadStandardIntent()).toBeNull();
    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(2);
    view.unmount();
    walletSends[1].approve(MERCHANT_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success', 'success']));
    expect(intentWrites).toEqual(['merchant', 'merchant']);
    expect(loadStandardIntent()).toMatchObject({
      stage: 'merchant',
      merchantTxHash: MERCHANT_TX,
    });
  });

  it('fee: mount 中に承認されると fee の印は 1 回だけ書かれる', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    await advanceToFeePrompt(view);
    expect(walletSends[1].tx.to?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(walletSends[1].tx.data).toBe(FEE_CALLDATA);
    intentWrites = [];

    await act(async () => {
      walletSends[1].approve(FEE_TX);
    });
    await waitFor(() => expect(view.result.current.phase).toBe('fee-mining'));
    expect(intentWrites).toEqual(['fee']);
    expect(loadStandardIntent()).toMatchObject({ stage: 'fee', feeTxHash: FEE_TX });
    view.unmount();
  });

  it('fee: 確認中に画面を離れてから承認されても fee の hash が残り、開き直した画面は fee-unknown で 2 本目の利用料を送らない', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    // 送信は SUBMITTED_AT。利用料の確認が出る (fee-awaiting を保存する) のは今の時刻 (送信より後)。
    await advanceToFeePrompt(first, SUBMITTED_AT);
    expect(loadStandardIntent()?.issuedAt).toBe(SUBMITTED_AT);
    intentWrites = [];

    first.unmount();
    // 利用料の承認も 10 分遅れる。印の issuedAt は送信した時刻のまま。
    const approvedLater = vi.spyOn(Date, 'now').mockReturnValue(SUBMITTED_AT + 10 * 60_000);
    walletSends[1].approve(FEE_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success', 'success']));
    approvedLater.mockRestore();
    expect(intentWrites).toEqual(['fee']);
    expect(loadStandardIntent()).toMatchObject({
      stage: 'fee',
      from: CUSTOMER,
      merchantTxHash: MERCHANT_TX,
      feeTxHash: FEE_TX,
      merchantBlockNumber: '100',
      merchantValue: '9950000',
      feeValue: '50000',
      contextKey: CONTEXT_KEY,
      orderLinkKey: ORDER_LINK_KEY,
      issuedAt: SUBMITTED_AT,
    });

    // 開き直した画面: fee の hash があるので fee-unknown (receipt の再照会だけ)。fee-error から 2 本目を送れない。
    const second = await tab.mountScreen();
    await waitFor(() => expect(second.result.current.phase).toBe('fee-unknown'));
    expect(second.result.current.feeTxHash).toBe(FEE_TX);
    act(() => second.result.current.retryFee());
    act(() => second.result.current.mutate(PARAMS));
    expect(tab.mutationStatuses()).toEqual(['success', 'success']);
    expect(walletSends).toHaveLength(2);
    expect(second.result.current.phase).toBe('fee-unknown');
    second.unmount();
  });

  it('fee: 送り直しで捨てた古い fee の試みが、画面を離れた後に承認されても保存しない (今の試みだけ保存する)', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    await advanceToFeePrompt(view);
    // fee の送り直し (reset → 新しい試み)。古い要求はウォレットに残ったまま。
    act(() => view.result.current.retryFee());
    await waitForWalletSends(3);
    intentWrites = [];
    view.unmount();

    walletSends[1].approve(OLD_FEE_TX);
    await waitFor(() =>
      expect(tab.mutationStatuses()).toEqual(['success', 'success', 'pending']),
    );
    expect(intentWrites).toEqual([]);
    expect(loadStandardIntent()).toMatchObject({ stage: 'fee-awaiting' });
    expect(loadStandardIntent()?.feeTxHash).toBeUndefined();

    walletSends[2].approve(FEE_TX);
    await waitFor(() =>
      expect(tab.mutationStatuses()).toEqual(['success', 'success', 'success']),
    );
    expect(intentWrites).toEqual(['fee']);
    expect(loadStandardIntent()).toMatchObject({ stage: 'fee', feeTxHash: FEE_TX });
  });

  it('fee: 次の支払いを始めて捨てた fee の試みは、画面を離れた後に承認されても保存しない', async () => {
    const tab = await makeTab();
    const view = await tab.mountScreen();
    await advanceToFeePrompt(view);
    // fee の確認が出ている間に、merchant の receipt が revert に変わる (巻き戻し)。印は消え、次の支払いを始められる。
    receiptByHash.set(MERCHANT_TX, {
      ...minedReceipt(MERCHANT_TX, 100n),
      data: { ...minedReceipt(MERCHANT_TX, 100n).data!, status: 'reverted' },
    });
    view.rerender();
    await waitFor(() => expect(loadStandardIntent()).toBeNull());
    await waitFor(() => expect(view.result.current.hasActiveIntent).toBe(false));
    // 次の支払い (mutate は fee の試みも reset で捨てる)。
    act(() => view.result.current.mutate(PARAMS));
    await waitForWalletSends(3);
    intentWrites = [];
    view.unmount();

    walletSends[1].approve(OLD_FEE_TX);
    await waitFor(() =>
      expect(tab.mutationStatuses()).toEqual(['success', 'success', 'pending']),
    );
    // 捨てた fee の hash で、今の支払い (まだ承認されていない) の印を作らない。
    expect(intentWrites).toEqual([]);
    expect(loadStandardIntent()).toBeNull();
  });

});

// Codex の MUST (PR #1061): 離れた画面の hook の要求 A が出たままの間に、新しい画面で支払い B を始めると、B が先に解決して B の
// 印を保存した後、遅れて解決した A が印を A に置き換える。A の receipt の成功で印が消え、B の印は永久に失われる (開き直すと B を
// もう一度払える)。直し方: 同じタブの中で、結果の出ていない要求を同時に 1 つだけにする (lib/standardPaymentOutstanding)。
describe('useStandardPayment: 離れた画面の要求が出たままの間は、新しい画面で始めない (H-D・Codex の MUST)', () => {
  it('merchant: 戻って新しい支払いを始めようとすると止まり、A が成功で解決すると A の印を読み込んで既存の復元 (merchant-unknown) になる', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    act(() => first.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(1);
    expect(outstandingRequest()).toBe('merchant');
    first.unmount();

    // 承認より前に新しい画面を開く。保存はまだ空だが、A の要求はウォレットに出たまま。
    const second = await tab.mountScreen();
    expect(loadStandardIntent()).toBeNull();
    // 見せるのは既存の送信中 (承認待ち) の状態。この画面の支払いとしては扱わない (通常決済を本線に固定・履歴に結び付けない)。
    expect(second.result.current.phase).toBe('merchant-sending');
    expect(second.result.current.isPending).toBe(true);
    expect(second.result.current.hasAttempt).toBe(true);
    expect(second.result.current.restoredFromStorage).toBe(true);
    expect(second.result.current.hasActiveIntent).toBe(false);

    // 新しい支払い B を始めようとしても、ウォレットへは出ない (直す前はここで 2 本目の要求が出て、B の印を A が上書きした)。
    act(() => second.result.current.mutate(PARAMS));
    act(() => second.result.current.retryFee());
    expect(walletSends).toHaveLength(1);
    expect(tab.mutationStatuses()).toEqual(['pending']);

    // A が成功で解決する: 離れた画面の hook が A の印を保存してから登録簿から外す → 開いている画面が読み込む。
    walletSends[0].approve(MERCHANT_TX);
    await waitFor(() => expect(second.result.current.phase).toBe('merchant-unknown'));
    expect(outstandingRequest()).toBeNull();
    expect(intentWrites).toEqual(['merchant']);
    expect(second.result.current.merchantTxHash).toBe(MERCHANT_TX);
    expect(second.result.current.hasActiveIntent).toBe(true);
    expect(second.result.current.restoredFromStorage).toBe(true);
    expect(second.result.current.isUnknown).toBe(true);
    act(() => second.result.current.mutate(PARAMS));
    expect(walletSends).toHaveLength(1);

    // receipt が取れると、読み直しのときと同じく先へ進む (利用料 0 = 成功・印を消す)。
    receiptByHash.set(MERCHANT_TX, minedReceipt(MERCHANT_TX, 100n));
    second.rerender();
    await waitFor(() => expect(second.result.current.phase).toBe('success'));
    expect(second.result.current.data?.merchantTxHash).toBe(MERCHANT_TX);
    expect(loadStandardIntent()).toBeNull();
    expect(walletSends).toHaveLength(1);
  });

  it('merchant: A が拒否で解決すると、止めを外して新しい画面で払える', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    act(() => first.result.current.mutate(PARAMS));
    await waitForWalletSends(1);
    first.unmount();

    const second = await tab.mountScreen();
    expect(second.result.current.phase).toBe('merchant-sending');
    act(() => second.result.current.mutate(PARAMS_NO_FEE));
    expect(walletSends).toHaveLength(1);

    // ウォレットで拒否 = 送金は出ていない。印は増えない。
    walletSends[0].reject();
    await waitFor(() => expect(second.result.current.phase).toBe('idle'));
    expect(outstandingRequest()).toBeNull();
    expect(tab.mutationStatuses()).toEqual(['error']);
    expect(loadStandardIntent()).toBeNull();
    expect(second.result.current.isPending).toBe(false);
    expect(second.result.current.hasAttempt).toBe(false);
    expect(second.result.current.restoredFromStorage).toBe(false);

    act(() => second.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(2);
    expect(walletSends[1].tx.data).toBe(MERCHANT_CALLDATA);
    await act(async () => {
      walletSends[1].approve(MERCHANT_TX);
    });
    await waitFor(() => expect(second.result.current.phase).toBe('merchant-mining'));
    expect(intentWrites).toEqual(['merchant']);
    expect(loadStandardIntent()).toMatchObject({ stage: 'merchant', merchantTxHash: MERCHANT_TX });
    expect(outstandingRequest()).toBeNull();
  });

  it('fee: A の利用料が出たままの間は、新しい画面から利用料を送り直せず (2 本目の利用料・印の上書き)、成功で解決すると fee-unknown になる', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    await advanceToFeePrompt(first);
    expect(outstandingRequest()).toBe('fee');
    intentWrites = [];
    first.unmount();

    // 新しい画面は送る前の印 (fee-awaiting) を読むが、A の利用料はウォレットに出たまま。
    const second = await tab.mountScreen();
    expect(second.result.current.hasActiveIntent).toBe(true);
    expect(second.result.current.phase).toBe('fee-sending');
    expect(second.result.current.isFeeError).toBe(false);
    expect(second.result.current.isPending).toBe(true);

    // 利用料の送り直しも新しい支払いも、ウォレットへは出ない (直す前は fee-error から 2 本目の利用料が出た)。
    act(() => second.result.current.retryFee());
    act(() => second.result.current.mutate(PARAMS));
    expect(walletSends).toHaveLength(2);
    expect(tab.mutationStatuses()).toEqual(['success', 'pending']);

    walletSends[1].approve(FEE_TX);
    await waitFor(() => expect(second.result.current.phase).toBe('fee-unknown'));
    expect(outstandingRequest()).toBeNull();
    expect(intentWrites).toEqual(['fee']);
    expect(second.result.current.feeTxHash).toBe(FEE_TX);
    expect(loadStandardIntent()).toMatchObject({
      stage: 'fee',
      merchantTxHash: MERCHANT_TX,
      feeTxHash: FEE_TX,
    });
    act(() => second.result.current.retryFee());
    expect(walletSends).toHaveLength(2);
  });

  it('fee: A の利用料が拒否で解決すると、新しい画面は fee-error に戻り、利用料を送り直せる', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    await advanceToFeePrompt(first);
    intentWrites = [];
    first.unmount();

    const second = await tab.mountScreen();
    expect(second.result.current.phase).toBe('fee-sending');
    walletSends[1].reject();
    await waitFor(() => expect(second.result.current.phase).toBe('fee-error'));
    expect(outstandingRequest()).toBeNull();
    expect(second.result.current.isFeeError).toBe(true);
    expect(loadStandardIntent()).toMatchObject({ stage: 'fee-awaiting' });
    expect(intentWrites).toEqual([]);

    act(() => second.result.current.retryFee());
    await waitForWalletSends(3);
    expect(walletSends[2].tx.data).toBe(FEE_CALLDATA);
    await act(async () => {
      walletSends[2].approve(FEE_TX);
    });
    await waitFor(() => expect(second.result.current.phase).toBe('fee-mining'));
    expect(loadStandardIntent()).toMatchObject({ stage: 'fee', feeTxHash: FEE_TX });
    expect(outstandingRequest()).toBeNull();
  });

  it('StrictMode の mount→unmount→mount の後も、登録簿には要求ごとに 1 つだけ載り、拒否・成功で外れる (mount 中は印を保存してから外す)', async () => {
    const tab = await makeTab();
    const effectRuns: string[] = [];
    const view = renderHook(
      () => {
        useEffect(() => {
          effectRuns.push('mount');
          return () => {
            effectRuns.push('unmount');
          };
        }, []);
        return useStandardPayment();
      },
      { wrapper: tab.Wrapper, reactStrictMode: true },
    );
    await waitFor(() => expect(view.result.current.isRestoring).toBe(false));
    expect(effectRuns).toEqual(['mount', 'unmount', 'mount']);
    expect(outstandingRequest()).toBeNull();

    // 自分の要求では自分を止めない。拒否で外れる。
    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(1);
    expect(outstandingRequest()).toBe('merchant');
    expect(view.result.current.phase).toBe('merchant-sending');
    expect(view.result.current.restoredFromStorage).toBe(false);
    await act(async () => {
      walletSends[0].reject();
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-error'));
    expect(outstandingRequest()).toBeNull();

    // 2 本目は、別の画面が同時に mount している間に出す。mount 中の今の試みの hash は、呼び出しごとの onSuccess が印を
    // 保存してから外すので、別の画面は外れた時点で印を読み込める。
    act(() => view.result.current.mutate(PARAMS_NO_FEE));
    await waitForWalletSends(2);
    const other = await tab.mountScreen();
    expect(other.result.current.phase).toBe('merchant-sending');
    await act(async () => {
      walletSends[1].approve(MERCHANT_TX);
    });
    await waitFor(() => expect(view.result.current.phase).toBe('merchant-mining'));
    await waitFor(() => expect(other.result.current.phase).toBe('merchant-unknown'));
    expect(other.result.current.merchantTxHash).toBe(MERCHANT_TX);
    expect(intentWrites).toEqual(['merchant']);
    expect(outstandingRequest()).toBeNull();
    expect(tab.mutationStatuses()).toEqual(['error', 'success']);
  });
});
