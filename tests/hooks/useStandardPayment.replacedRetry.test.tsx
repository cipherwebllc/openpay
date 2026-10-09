import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createConfig,
  createStorage,
  noopStorage,
  WagmiProvider,
} from 'wagmi';
import { custom, encodeFunctionData, erc20Abi, numberToHex, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { STANDARD_INTENT_STORAGE_KEY } from '@/lib/paymentIntentStorage';

// Codex xHigh 再レビュー P2 (#764): 置換先 (高速化) が revert すると wagmi は throw するが、receipt query
// は TanStack Query の既定 retry (3 回) が終わるまで error にならない。retry は送った元の hash を
// 再び待ち、元 tx が RPC から消えていると (wagmi の timeout=0 で) 永久に待つ → useConfirmedRevert の
// receiptError 条件を満たさず merchant-mining / fee-mining から抜けられない。
// useStandardPayment.test.tsx は receipt query を状態で直接置き換えるのでこの経路を検出できない。
// ここは **実際の wagmi useWaitForTransactionReceipt・viem の置換検出・TanStack の retry** を走らせ、
// RPC (JSON-RPC の応答) だけを custom transport で再現する。useAccount / useWriteContract (wallet) のみ mock。

const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const FEE_RECEIVER: Address = '0xdead000000000000000000000000000000001234';
const MERCHANT_TX: Hex = `0x${'a'.repeat(64)}`;
const FEE_TX: Hex = `0x${'b'.repeat(64)}`;
const MERCHANT_REPLACEMENT_TX: Hex = `0x${'c'.repeat(64)}`;
const FEE_REPLACEMENT_TX: Hex = `0x${'d'.repeat(64)}`;
const NEXT_MERCHANT_TX: Hex = `0x${'e'.repeat(64)}`;
const BLOCK_NUMBER = 100;
const BLOCK_HASH: Hex = `0x${'f'.repeat(64)}`;

type RpcTx = Record<string, unknown> & { hash: Hex; nonce: Hex };
type RpcReceipt = Record<string, unknown> & { transactionHash: Hex };
type SimTx = { tx: RpcTx; receipt: RpcReceipt | null };

// 再現する chain: 1 ブロック (100) が最新のまま。tx は mempool (receipt なし) か block 100 に mine 済み。
const sim = {
  txs: new Map<Hex, SimTx>(),
  // 置換先が mine されたら元 tx は node から消える (置換先の receipt を返した時点で元を消す)。
  replaced: new Map<Hex, Hex>(),
  requests: [] as { method: string; params: unknown[] }[],
  stopped: false,
};

function rpcTx(
  hash: Hex,
  nonce: number,
  mined: boolean,
  call: { to: Address; input: Hex },
): RpcTx {
  return {
    hash,
    nonce: numberToHex(nonce),
    from: CUSTOMER,
    to: call.to,
    value: '0x0',
    input: call.input,
    gas: '0xc350',
    type: '0x2',
    chainId: numberToHex(baseSepolia.id),
    maxFeePerGas: '0x2',
    maxPriorityFeePerGas: '0x1',
    blockHash: mined ? BLOCK_HASH : null,
    blockNumber: mined ? numberToHex(BLOCK_NUMBER) : null,
    transactionIndex: mined ? '0x0' : null,
    v: '0x0',
    r: '0x1',
    s: '0x1',
    yParity: '0x0',
    accessList: [],
  };
}

function rpcReceipt(hash: Hex, status: 'success' | 'reverted'): RpcReceipt {
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: BLOCK_HASH,
    blockNumber: numberToHex(BLOCK_NUMBER),
    from: CUSTOMER,
    to: TOKEN,
    cumulativeGasUsed: '0xc350',
    gasUsed: '0xc350',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logs: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    status: status === 'success' ? '0x1' : '0x0',
    type: '0x2',
  };
}

function transferCall(to: Address, value: bigint) {
  return {
    to: TOKEN,
    input: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, value],
    }),
  };
}

// mempool にある送った tx と、同じ nonce で mine 済みの置換先 (同内容 = 高速化) を置く。
function pendingReplacedBy(
  sent: Hex,
  replacement: Hex,
  nonce: number,
  call: { to: Address; input: Hex },
  status: 'success' | 'reverted',
) {
  sim.txs.set(sent, { tx: rpcTx(sent, nonce, false, call), receipt: null });
  sim.txs.set(replacement, {
    tx: rpcTx(replacement, nonce, true, call),
    receipt: rpcReceipt(replacement, status),
  });
  sim.replaced.set(replacement, sent);
}

function minedOk(hash: Hex, nonce: number, call: { to: Address; input: Hex }) {
  sim.txs.set(hash, {
    tx: rpcTx(hash, nonce, true, call),
    receipt: rpcReceipt(hash, 'success'),
  });
}

function requestsOf(method: string, hash?: Hex) {
  return sim.requests.filter(
    (r) => r.method === method && (hash === undefined || r.params[0] === hash),
  );
}

const transport = custom({
  async request({ method, params }: { method: string; params?: unknown[] }) {
    // test 終了後は応答しない (viem の polling / retry timer を次の test へ持ち越さない)。
    if (sim.stopped) return new Promise(() => {});
    const p = params ?? [];
    sim.requests.push({ method, params: p });
    switch (method) {
      case 'eth_blockNumber':
        return numberToHex(BLOCK_NUMBER);
      case 'eth_getTransactionByHash':
        return sim.txs.get(p[0] as Hex)?.tx ?? null;
      case 'eth_getTransactionReceipt': {
        const hash = p[0] as Hex;
        const receipt = sim.txs.get(hash)?.receipt ?? null;
        const sent = sim.replaced.get(hash);
        if (receipt && sent) sim.txs.delete(sent);
        return receipt;
      }
      case 'eth_getBlockByNumber':
        return {
          number: numberToHex(BLOCK_NUMBER),
          hash: BLOCK_HASH,
          parentHash: `0x${'1'.repeat(64)}`,
          timestamp: '0x1',
          gasLimit: '0x1c9c380',
          gasUsed: '0xc350',
          baseFeePerGas: '0x1',
          miner: '0x0000000000000000000000000000000000000000',
          nonce: '0x0000000000000000',
          difficulty: '0x0',
          size: '0x1',
          extraData: '0x',
          logsBloom: `0x${'0'.repeat(512)}`,
          sha3Uncles: `0x${'2'.repeat(64)}`,
          stateRoot: `0x${'3'.repeat(64)}`,
          transactionsRoot: `0x${'4'.repeat(64)}`,
          receiptsRoot: `0x${'5'.repeat(64)}`,
          mixHash: `0x${'6'.repeat(64)}`,
          uncles: [],
          transactions: [...sim.txs.values()]
            .filter((e) => e.tx.blockNumber !== null)
            .map((e) => (p[1] ? e.tx : e.tx.hash)),
        };
      case 'eth_call':
        // wagmi が revert 理由を取りに来る (理由は '0x' = unknown reason)。
        return '0x';
      default:
        throw new Error(`unexpected rpc method ${method}`);
    }
  },
});

const useWriteContractMockA = { writeContract: vi.fn(), reset: vi.fn() };
const useWriteContractMockB = { writeContract: vi.fn(), reset: vi.fn() };
const writeState = {
  a: { data: undefined as Hex | undefined, error: null as Error | null, isPending: false },
  b: { data: undefined as Hex | undefined, error: null as Error | null, isPending: false },
};
let writeCallCount = 0;
vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>();
  return {
    ...actual,
    useAccount: () => ({ address: CUSTOMER }),
    // useStandardPayment.test.tsx と同じ: render ごとに merchant → fee の順で 2 回呼ばれる。
    useWriteContract: () => {
      writeCallCount++;
      return writeCallCount % 2 === 1
        ? { ...useWriteContractMockA, ...writeState.a }
        : { ...useWriteContractMockB, ...writeState.b };
    },
  };
});

const logPaymentEventMock = vi.fn();
vi.mock('@/lib/paymentLog', () => ({
  logPaymentEvent: (...args: unknown[]) => logPaymentEventMock(...args),
  buildPaymentLogEvent: (ctx: object, outcome: object) => ({ ...ctx, ...outcome }),
}));

import { useStandardPayment } from '@/hooks/useStandardPayment';

const params = {
  tokenAddress: TOKEN,
  merchant: MERCHANT,
  merchantAmount: 9_950_000n,
  feeReceiver: FEE_RECEIVER,
  feeAmount: 50_000n,
  chainId: baseSepolia.id,
};
const merchantCall = transferCall(MERCHANT, params.merchantAmount);
const feeCall = transferCall(FEE_RECEIVER, params.feeAmount);

function onSuccessOf(mock: { mock: { calls: unknown[][] } }, index: number) {
  return (mock.mock.calls[index]?.[1] as { onSuccess?: (hash: Hex) => void })
    ?.onSuccess;
}

async function renderWithRealWagmi() {
  const config = createConfig({
    chains: [baseSepolia],
    transports: { [baseSepolia.id]: transport },
    // viem の block polling を速める (既定 4s)。retry / 置換検出のロジックは変えない。
    pollingInterval: 10,
    storage: createStorage({ storage: noopStorage }),
    multiInjectedProviderDiscovery: false,
  });
  // retry は TanStack Query の既定 (3 回) のまま。retryDelay (既定 1s→2s→4s) だけ 0 にして、
  // 「retry が元 hash を再び待つ」経路へ test 内で到達させる。
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0 } },
  });
  // lib/wagmi.ts が wagmi の Register に本番 config の型を登録しているため、test 用 config は型だけ合わせる。
  const providerConfig = config as unknown as Parameters<typeof WagmiProvider>[0]['config'];
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WagmiProvider config={providerConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
  const hook = renderHook(() => useStandardPayment(), { wrapper });
  await waitFor(() => expect(hook.result.current.isRestoring).toBe(false));
  return hook;
}

function merchantLogs() {
  return logPaymentEventMock.mock.calls
    .map((call) => call[0])
    .filter((event) => event?.flow === 'standard-merchant');
}

beforeEach(() => {
  window.sessionStorage.clear();
  sim.txs.clear();
  sim.replaced.clear();
  sim.requests.length = 0;
  sim.stopped = false;
  writeCallCount = 0;
  writeState.a = { data: undefined, error: null, isPending: false };
  writeState.b = { data: undefined, error: null, isPending: false };
  useWriteContractMockA.writeContract = vi.fn();
  useWriteContractMockB.writeContract = vi.fn();
  // 実際の useWriteContract().reset() は同じ event の batch 内で data を消す (次の render に前回 hash を残さない)。
  useWriteContractMockA.reset = vi.fn(() => {
    writeState.a = { data: undefined, error: null, isPending: false };
  });
  useWriteContractMockB.reset = vi.fn(() => {
    writeState.b = { data: undefined, error: null, isPending: false };
  });
  logPaymentEventMock.mockReset();
});

afterEach(() => {
  sim.stopped = true;
});

describe('useStandardPayment: 置換先の revert を query の retry 完了を待たずに確定する (実 wagmi / viem / TanStack)', () => {
  it('merchant: 高速化した置換先が revert・元 tx は RPC から消える → retry が元 hash を待ち続けても merchant-error に抜ける', async () => {
    pendingReplacedBy(MERCHANT_TX, MERCHANT_REPLACEMENT_TX, 7, merchantCall, 'reverted');
    const { result, rerender } = await renderWithRealWagmi();

    act(() => result.current.mutate(params));
    act(() => onSuccessOf(useWriteContractMockA.writeContract, 0)?.(MERCHANT_TX));
    act(() => {
      writeState.a.data = MERCHANT_TX;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('merchant-mining'));

    // viem が block 100 で同じ nonce の置換先を見つけ、その receipt (reverted) を onReplaced で渡す。
    // wagmi は reverted で throw → TanStack は retry (元の hash で再び待つ・元 tx は消えている)。
    await waitFor(() => expect(result.current.phase).toBe('merchant-error'));
    expect(result.current.isUnknown).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)).toBeNull();
    expect(result.current.hasActiveIntent).toBe(false);

    // retry は確かに元の hash を再び待っている (= query の error は立たない) が、確定は揺らがない。
    await waitFor(() =>
      expect(requestsOf('eth_getTransactionReceipt', MERCHANT_TX).length).toBeGreaterThanOrEqual(2),
    );
    rerender();
    expect(result.current.phase).toBe('merchant-error');
    expect(result.current.isUnknown).toBe(false);

    // 決済ログは送った hash の error として残す (A1 と同じ・success は残さない)。
    await waitFor(() =>
      expect(merchantLogs().some((e) => e?.result === 'error' && e?.txHash === MERCHANT_TX)).toBe(true),
    );
    expect(merchantLogs().some((e) => e?.result === 'success')).toBe(false);

    // 置換先が同じ nonce を消費済み = 元の送金は永久に成立しない → 次の決済を塞がない。
    act(() => result.current.mutate(params));
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledTimes(2);
    act(() => {
      writeState.a.data = NEXT_MERCHANT_TX;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('merchant-mining'));
  });

  it('fee: 置換先が revert・元 tx は RPC から消える → fee-error (merchant 確定は維持・fee 再送は可)', async () => {
    minedOk(MERCHANT_TX, 7, merchantCall);
    pendingReplacedBy(FEE_TX, FEE_REPLACEMENT_TX, 8, feeCall, 'reverted');
    const { result, rerender } = await renderWithRealWagmi();

    act(() => result.current.mutate(params));
    act(() => onSuccessOf(useWriteContractMockA.writeContract, 0)?.(MERCHANT_TX));
    act(() => {
      writeState.a.data = MERCHANT_TX;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce(),
    );
    act(() => onSuccessOf(useWriteContractMockB.writeContract, 0)?.(FEE_TX));
    act(() => {
      writeState.b.data = FEE_TX;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-mining'));

    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    expect(result.current.isUnknown).toBe(false);
    expect(result.current.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.merchantBlockNumber).toBe(BigInt(BLOCK_NUMBER));
    expect(
      JSON.parse(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!),
    ).toMatchObject({
      stage: 'fee-awaiting',
      merchantTxHash: MERCHANT_TX,
      merchantBlockNumber: String(BLOCK_NUMBER),
    });

    await waitFor(() =>
      expect(requestsOf('eth_getTransactionReceipt', FEE_TX).length).toBeGreaterThanOrEqual(2),
    );
    rerender();
    expect(result.current.phase).toBe('fee-error');

    act(() => result.current.retryFee());
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledTimes(2);
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledTimes(1);
  });

  it('同内容の置換先が成功したときは従来どおり query の成功で進む (置換先の hash で fee を起動)', async () => {
    pendingReplacedBy(MERCHANT_TX, MERCHANT_REPLACEMENT_TX, 7, merchantCall, 'success');
    // 置換先の receipt に同じ Transfer を載せる (同内容 = 高速化)。
    const entry = sim.txs.get(MERCHANT_REPLACEMENT_TX)!;
    entry.receipt = {
      ...entry.receipt!,
      logs: [
        {
          address: TOKEN,
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            `0x${CUSTOMER.slice(2).toLowerCase().padStart(64, '0')}`,
            `0x${MERCHANT.slice(2).toLowerCase().padStart(64, '0')}`,
          ],
          data: `0x${params.merchantAmount.toString(16).padStart(64, '0')}`,
          blockNumber: numberToHex(BLOCK_NUMBER),
          blockHash: BLOCK_HASH,
          transactionHash: MERCHANT_REPLACEMENT_TX,
          transactionIndex: '0x0',
          logIndex: '0x0',
          removed: false,
        },
      ],
    };
    const { result, rerender } = await renderWithRealWagmi();

    act(() => result.current.mutate(params));
    act(() => onSuccessOf(useWriteContractMockA.writeContract, 0)?.(MERCHANT_TX));
    act(() => {
      writeState.a.data = MERCHANT_TX;
    });
    rerender();

    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce(),
    );
    expect(result.current.phase).toBe('fee-sending');
    expect(result.current.merchantTxHash).toBe(MERCHANT_REPLACEMENT_TX);
    expect(
      JSON.parse(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!),
    ).toMatchObject({ stage: 'fee-awaiting', merchantTxHash: MERCHANT_REPLACEMENT_TX });
  });
});
