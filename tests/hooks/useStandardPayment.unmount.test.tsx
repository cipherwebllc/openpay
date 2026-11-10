import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// ウォレットに届いた送金の要求 (eth_sendTransaction)。承認 = approve(hash) を呼ぶまで止まる。
type WalletSend = {
  tx: { to?: string; data?: string; from?: string };
  approve: (hash: Hex) => void;
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
    return new Promise<Hex>((resolve) => {
      walletSends.push({
        tx: (params as WalletSend['tx'][])[0],
        approve: resolve,
      });
    });
  }
  return Promise.reject(new Error(`unexpected wallet method: ${method}`));
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

async function waitForWalletSends(count: number) {
  await waitFor(() => expect(walletSends).toHaveLength(count));
}

// merchant を送って mine まで進め、fee の確認がウォレットに出ている所まで (fee の要求は walletSends[1])。
async function advanceToFeePrompt(
  view: Awaited<ReturnType<Awaited<ReturnType<typeof makeTab>>['mountScreen']>>,
) {
  act(() => view.result.current.mutate(PARAMS));
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
    act(() => first.result.current.mutate(PARAMS));
    await waitForWalletSends(1);
    expect(first.result.current.phase).toBe('merchant-sending');

    // ウォレットの確認が出ている間に画面を離れる (/pay のヘッダの Link・言語の切り替え・accordion を閉じる)。
    first.unmount();
    expect(loadStandardIntent()).toBeNull();

    // その後でウォレットが承認する = 送金は broadcast される。
    walletSends[0].approve(MERCHANT_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success']));
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
      issuedAt: expect.any(Number),
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
    await advanceToFeePrompt(first);
    intentWrites = [];

    first.unmount();
    walletSends[1].approve(FEE_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success', 'success']));
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

  it('既知の限界: 承認より前に開き直した画面は、後から書かれた印を知らない (保存には残る・読み直すと止まる)', async () => {
    const tab = await makeTab();
    const first = await tab.mountScreen();
    act(() => first.result.current.mutate(PARAMS));
    await waitForWalletSends(1);
    first.unmount();
    // 承認より前に開き直す: 新しい hook は空の保存を読む。
    const second = await tab.mountScreen();
    expect(second.result.current.phase).toBe('idle');

    walletSends[0].approve(MERCHANT_TX);
    await waitFor(() => expect(tab.mutationStatuses()).toEqual(['success']));
    // 印は保存に残る (離れた画面の hook が書く) が、開いている画面の hook は読み直さない。
    expect(loadStandardIntent()).toMatchObject({
      stage: 'merchant',
      merchantTxHash: MERCHANT_TX,
    });
    expect(second.result.current.hasActiveIntent).toBe(false);
    expect(second.result.current.phase).toBe('idle');
    second.unmount();

    // 読み直す (もう一度開き直す) と、印を読んで止まる。
    const third = await tab.mountScreen();
    await waitFor(() => expect(third.result.current.phase).toBe('merchant-unknown'));
    third.unmount();
  });
});
