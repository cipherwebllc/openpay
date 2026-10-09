import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import {
  STANDARD_INTENT_STORAGE_KEY,
  type StandardIntentMetadata,
} from '@/lib/paymentIntentStorage';

// 実際の viem receipt の形 (transactionHash・from・logs を必ず持つ)。viem の
// waitForTransactionReceipt は同じ nonce の置換 (高速化・取消) を見つけると置換 tx の
// receipt で resolve するため、transactionHash が送信した hash と一致しない receipt が来得る。
type MockReceiptLog = { address: Address; topics: Hex[]; data: Hex };
type MockReceipt = {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionHash: Hex;
  from: Address;
  logs: MockReceiptLog[];
};

// wagmi の useAccount / useWriteContract / useWaitForTransactionReceipt / usePublicClient を
// 境界モック。useStandardPayment 本体のロジック (phase 遷移 / 2-tx 直列 / retry / log) は実コードを走らせる。
const useAccountMock = vi.fn();
// A4: wagmi の receipt query が error のときだけ、生の receipt (getTransactionReceipt) を引く。
const publicClientMock = {
  getTransactionReceipt: vi.fn(),
};
const useWriteContractMockA = { writeContract: vi.fn(), reset: vi.fn() };
const useWriteContractMockB = { writeContract: vi.fn(), reset: vi.fn() };
const useWriteContractMockState = {
  a: {
    data: undefined as Hex | undefined,
    error: null as Error | null,
    isPending: false,
  },
  b: {
    data: undefined as Hex | undefined,
    error: null as Error | null,
    isPending: false,
  },
};
const useWaitMockState = {
  a: {
    data: undefined as MockReceipt | undefined,
    error: null as Error | null,
    isSuccess: false,
    isError: false,
    refetch: vi.fn(),
  },
  b: {
    data: undefined as MockReceipt | undefined,
    error: null as Error | null,
    isSuccess: false,
    isError: false,
    refetch: vi.fn(),
  },
};
// useWriteContract は 2 回呼ばれる (merchant / fee 用)。順序で振り分け。
let writeCallCount = 0;
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
  usePublicClient: () => publicClientMock,
  useWriteContract: () => {
    writeCallCount++;
    if (writeCallCount % 2 === 1) {
      return {
        ...useWriteContractMockA,
        ...useWriteContractMockState.a,
      };
    }
    return {
      ...useWriteContractMockB,
      ...useWriteContractMockState.b,
    };
  },
  useWaitForTransactionReceipt: ({ hash }: { hash: Hex | undefined }) => {
    // hash の値で a / b を識別 (merchant tx と fee tx で別)
    if (
      hash !== undefined &&
      (hash === useWriteContractMockState.a.data || hash === MERCHANT_TX)
    ) {
      return useWaitMockState.a;
    }
    if (
      hash !== undefined &&
      (hash === useWriteContractMockState.b.data || hash === FEE_TX)
    ) {
      return useWaitMockState.b;
    }
    return {
      data: undefined,
      error: null,
      isSuccess: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));

// paymentLog は fire-and-forget で外部 HTTP を打つ。ここでは発火回数だけ観察。
const logPaymentEventMock = vi.fn();
vi.mock('@/lib/paymentLog', () => ({
  logPaymentEvent: (...args: unknown[]) => logPaymentEventMock(...args),
  buildPaymentLogEvent: (ctx: object, outcome: object) => ({ ...ctx, ...outcome }),
}));

import { useStandardPayment } from '@/hooks/useStandardPayment';

const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const FEE_RECEIVER: Address = '0xdead000000000000000000000000000000001234';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const OTHER_CUSTOMER: Address =
  '0x8888888888888888888888888888888888888888';
const MERCHANT_TX: Hex = `0x${'a'.repeat(64)}`;
const FEE_TX: Hex = `0x${'b'.repeat(64)}`;
// 同じ nonce で送り直された置換 tx (wallet の高速化 / 取消) の hash。
const MERCHANT_REPLACEMENT_TX: Hex = `0x${'c'.repeat(64)}`;
const FEE_REPLACEMENT_TX: Hex = `0x${'d'.repeat(64)}`;

// hash の tx が mine された success receipt (置換が無ければ transactionHash = 送信 hash)。
function minedReceipt(
  hash: Hex,
  blockNumber: bigint,
  overrides: Partial<MockReceipt> = {},
): MockReceipt {
  return {
    status: 'success',
    blockNumber,
    transactionHash: hash,
    from: CUSTOMER,
    logs: [],
    ...overrides,
  };
}

// ERC-20 Transfer log を viem の encoder で組む (hook 側の照合を実 ABI encoding で検証する)。
function transferLog(
  to: Address,
  value: bigint,
  opts: { token?: Address; from?: Address } = {},
): MockReceiptLog {
  return {
    address: opts.token ?? TOKEN,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: opts.from ?? CUSTOMER, to },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

// 実際の @wagmi/core の waitForTransactionReceipt は reverted receipt を data で返さず、
// revert 理由の Error を throw する (node_modules/@wagmi/core/src/actions/waitForTransactionReceipt.ts)。
function wagmiRevertError(): Error {
  return new Error('ERC20: transfer amount exceeds balance');
}

async function renderReadyStandardPayment() {
  const hook = renderHook(() => useStandardPayment());
  await waitFor(() => expect(hook.result.current.isRestoring).toBe(false));
  return hook;
}

function seedStandardIntent(
  overrides: Partial<StandardIntentMetadata> = {},
): void {
  const intent: StandardIntentMetadata = {
    version: 1,
    chainId: 84532,
    from: CUSTOMER,
    tokenAddress: TOKEN,
    merchant: MERCHANT,
    merchantValue: '9950000',
    feeReceiver: FEE_RECEIVER,
    feeValue: '50000',
    saleValue: '10000000',
    stage: 'merchant',
    merchantTxHash: MERCHANT_TX,
    issuedAt: Date.now(),
    ...overrides,
  };
  window.sessionStorage.setItem(
    STANDARD_INTENT_STORAGE_KEY,
    JSON.stringify(intent),
  );
}

function resetMocks() {
  writeCallCount = 0;
  useWriteContractMockA.writeContract = vi.fn();
  useWriteContractMockA.reset = vi.fn();
  useWriteContractMockB.writeContract = vi.fn();
  useWriteContractMockB.reset = vi.fn();
  useWriteContractMockState.a.data = undefined;
  useWriteContractMockState.a.error = null;
  useWriteContractMockState.a.isPending = false;
  useWriteContractMockState.b.data = undefined;
  useWriteContractMockState.b.error = null;
  useWriteContractMockState.b.isPending = false;
  useWaitMockState.a.data = undefined;
  useWaitMockState.a.error = null;
  useWaitMockState.a.isSuccess = false;
  useWaitMockState.a.isError = false;
  useWaitMockState.a.refetch.mockReset();
  useWaitMockState.b.data = undefined;
  useWaitMockState.b.error = null;
  useWaitMockState.b.isSuccess = false;
  useWaitMockState.b.isError = false;
  useWaitMockState.b.refetch.mockReset();
  logPaymentEventMock.mockReset();
  useAccountMock.mockReturnValue({ address: CUSTOMER });
  // 既定は「生の receipt も取れない」(RPC 障害・未 mine)。revert を確かめる test だけ上書きする。
  publicClientMock.getTransactionReceipt = vi
    .fn()
    .mockRejectedValue(new Error('rpc receipt fetch failed'));
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetMocks();
});

describe('useStandardPayment', () => {
  // ==========================================================================
  // hook contract smoke check (mock fragility 検出用)
  // ==========================================================================
  // 本 file の wagmi mock は useWriteContract の呼出順序 (1 回目 = merchant、2 回目
  // = fee) に依存する。hook が render 内で useWriteContract を「2 回」呼ばなく
  // なった場合 (例: 3 つ目の tx を追加 / 1 つに統合) mock の alternation が silent
  // に壊れて test 全体が誤った mock instance を使う。この smoke check が render
  // あたりの呼出回数を fence するため、回数変更時は **mock pattern の更新が必須**
  // であることを後続の test 開発者に明示する。
  it('hook contract: useWriteContract は render あたり exactly 2 回呼出される (mock alternation 前提)', () => {
    writeCallCount = 0;
    renderHook(() => useStandardPayment());
    expect(
      writeCallCount,
      'hook が useWriteContract の呼出数を変更した場合、tests/hooks/useStandardPayment.test.tsx の ' +
        'writeCallCount-based mock alternation も同期更新が必要',
    ).toBe(2);
  });

  it('idle 状態: phase=idle、isPending/isSuccess/isError 全 false、data=undefined', async () => {
    const { result } = await renderReadyStandardPayment();
    expect(result.current.phase).toBe('idle');
    expect(result.current.isPending).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('mutate(merchantAmount=0): pre-validation で reject、writeContract は呼ばれない', async () => {
    const { result } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 0n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();
    expect(result.current.error?.message).toMatch(/送金額が 0/);
  });

  it('mutate(): merchant tx を発火、phase=merchant-sending', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    rerender();
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();
    const callArg = useWriteContractMockA.writeContract.mock.calls[0][0];
    expect(callArg.address).toBe(TOKEN);
    expect(callArg.functionName).toBe('transfer');
    expect(callArg.args).toEqual([MERCHANT, 9_950_000n]);
    expect(callArg.chainId).toBe(84532);
    expect(result.current.phase).toBe('merchant-sending');
    expect(result.current.isPending).toBe(true);
  });

  it('merchant tx 成功 + feeAmount > 0: fee tx が自動発火、phase=fee-sending', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    // merchant tx broadcast 完了
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
    });
    rerender();
    // receipt 確定
    act(() => {
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => {
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce();
    });
    const feeCall = useWriteContractMockB.writeContract.mock.calls[0][0];
    expect(feeCall.args).toEqual([FEE_RECEIVER, 50_000n]);
    expect(result.current.phase).toBe('fee-sending');
  });

  it('merchant tx 成功 + feeAmount = 0: fee tx をスキップして success', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 199n, // 199 wei × 0.5% = 0 fee
        feeReceiver: FEE_RECEIVER,
        feeAmount: 0n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => {
      expect(result.current.phase).toBe('success');
    });
    // fee tx は発火しない
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
    expect(result.current.data?.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.data?.feeTxHash).toBeUndefined();
  });

  it('merchant tx 失敗: phase=merchant-error、fee tx は発火しない', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.error = new Error('user rejected');
    });
    rerender();
    await waitFor(() => {
      expect(result.current.phase).toBe('merchant-error');
    });
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
    expect(result.current.isError).toBe(true);
    expect(result.current.error?.message).toBe('user rejected');
  });

  it('merchant tx revert (wagmi は throw): 生の receipt で reverted を確かめて merchant-error', async () => {
    // A4: 実際の wagmi は reverted receipt を data で返さず throw する。query error のときに
    // getTransactionReceipt を 1 回引き、reverted を確認できたときだけ確定失敗へ進む。
    publicClientMock.getTransactionReceipt.mockResolvedValue(
      minedReceipt(MERCHANT_TX, 100n, { status: 'reverted' }),
    );
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.error = wagmiRevertError();
      useWaitMockState.a.isError = true;
    });
    rerender();
    await waitFor(() => {
      expect(result.current.phase).toBe('merchant-error');
    });
    expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledOnce();
    expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledWith({
      hash: MERCHANT_TX,
    });
    expect(result.current.isMerchantError).toBe(true);
    expect(result.current.isUnknown).toBe(false);
    // fee tx は発火しない (merchant が revert したので)
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
    // 既存の reverted と同じ後片付け: intent を消し、次の決済を塞がない。
    expect(result.current.hasActiveIntent).toBe(false);
    expect(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('merchant receipt RPC エラー: merchant-unknown で新規送金を封鎖し、receipt 再照会後の success でのみ fee を開始', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    const params = {
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantAmount: 9_950_000n,
      feeReceiver: FEE_RECEIVER,
      feeAmount: 50_000n,
      chainId: 84532,
    };
    act(() => result.current.mutate(params));
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.error = new Error('merchant receipt rpc timeout');
      useWaitMockState.a.isError = true;
    });
    rerender();

    await waitFor(() => expect(result.current.phase).toBe('merchant-unknown'));
    expect(result.current.isUnknown).toBe(true);
    expect(result.current.isMerchantUnknown).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();

    // unknown 中は hook 直呼びでも main Pay 相当の mutate を再送しない。
    act(() => result.current.mutate(params));
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();

    act(() => result.current.retryReceipt());
    expect(useWaitMockState.a.refetch).toHaveBeenCalledOnce();

    act(() => {
      useWaitMockState.a.error = null;
      useWaitMockState.a.isError = false;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce(),
    );
    expect(result.current.phase).toBe('fee-sending');

    // unknown telemetry を先に記録しても、同じ hash の終端 success は消えない。
    const merchantLogs = logPaymentEventMock.mock.calls
      .map((call) => call[0])
      .filter((event) => event?.flow === 'standard-merchant');
    expect(merchantLogs.some((event) => event?.result === 'error')).toBe(true);
    expect(
      merchantLogs.some(
        (event) => event?.result === 'success' && event?.txHash === MERCHANT_TX,
      ),
    ).toBe(true);
  });

  it('merchant-unknown の receipt 再照会が reverted に到達: merchant-error へ移り fee は送信しない', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.error = new Error('merchant receipt rpc timeout');
      useWaitMockState.a.isError = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('merchant-unknown'));

    // 1 回目の生 receipt 照会は RPC 障害 (既定) → revert の証拠ではないので unknown のまま。
    await waitFor(() =>
      expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledOnce(),
    );
    expect(result.current.phase).toBe('merchant-unknown');

    // 再照会: wagmi は revert 理由で throw し、生の receipt で reverted を確かめられる。
    publicClientMock.getTransactionReceipt.mockResolvedValue(
      minedReceipt(MERCHANT_TX, 100n, { status: 'reverted' }),
    );
    act(() => result.current.retryReceipt());
    act(() => {
      useWaitMockState.a.error = wagmiRevertError();
      useWaitMockState.a.isError = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('merchant-error'));
    expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(result.current.isMerchantError).toBe(true);
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
  });

  it('fee tx 失敗 (wallet reject): phase=fee-error、merchant 確定済 = data には merchant hash あり', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => {
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled();
    });
    // fee tx が wallet 段階で reject
    act(() => {
      useWriteContractMockState.b.error = new Error('user rejected fee tx');
    });
    rerender();
    await waitFor(() => {
      expect(result.current.phase).toBe('fee-error');
    });
    expect(result.current.isFeeError).toBe(true);
    expect(result.current.isMerchantError).toBe(false);
    // data はまだ undefined (fee tx 未確定なので)
    expect(result.current.data).toBeUndefined();
    // R: codex review #1 (P2) regression — fee-error 時にも merchant 着金の証跡は揃う:
    //    merchantBlockNumber (merchant receipt 単独) と lastSubmittedParams (mutate 引数 snapshot) を
    //    usePaymentHistory が読み取って merchant 行を補完 append する経路の必須インプット。
    expect(result.current.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.merchantBlockNumber).toBe(100n);
    expect(result.current.lastSubmittedParams).toMatchObject({
      merchantAmount: 9_950_000n,
      feeAmount: 50_000n,
    });
  });

  it('merchant 確定前に wallet が別 payer へ切り替わったら fee を自動送信せず latch を維持する', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useAccountMock.mockReturnValue({ address: OTHER_CUSTOMER });
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();

    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
    expect(result.current.hasActiveIntent).toBe(true);
    expect(
      JSON.parse(
        window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!,
      ),
    ).toMatchObject({
      from: CUSTOMER,
      stage: 'fee-awaiting',
      merchantTxHash: MERCHANT_TX,
      merchantBlockNumber: '100',
    });
  });

  it('retryFee(): fee tx を再送信、merchant tx は再呼び出ししない', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => {
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce();
    });
    // fee tx reject
    act(() => {
      useWriteContractMockState.b.error = new Error('reject 1');
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));

    // retry
    act(() => {
      useWriteContractMockState.b.error = null;
      result.current.retryFee();
    });
    rerender();
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledTimes(2);
    // merchant 側は 1 回だけ
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();
  });

  it('全成功: phase=success、data に merchant + fee hash + block', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data?.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.data?.feeTxHash).toBe(FEE_TX);
    expect(result.current.data?.blockNumber).toBe(100n);
  });

  it('paymentLog: merchant tx 成功時に standard-merchant flow で 1 度発火', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => {
      expect(logPaymentEventMock).toHaveBeenCalled();
    });
    const merchantLog = logPaymentEventMock.mock.calls.find(
      (c) => c[0]?.flow === 'standard-merchant',
    );
    expect(merchantLog).toBeDefined();
    expect(merchantLog?.[0]?.result).toBe('success');
    expect(merchantLog?.[0]?.txHash).toBe(MERCHANT_TX);
  });

  it('レジ standard は plain transfer のまま送り、確定後に fee txHash を通知する (通知は phase 不変)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true,"status":"claimed"}'));
    global.fetch = fetchMock;
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        saleAmount: 10_000_000n,
        registerFee: true,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    // 顧客の署名対象は従来どおり ERC20.transfer (署名回数・ガス・フロー不変)。
    const feeCall = useWriteContractMockB.writeContract.mock.calls[0][0];
    expect(feeCall.functionName).toBe('transfer');
    expect(feeCall.args).toEqual([FEE_RECEIVER, 50_000n]);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/register/claim');
    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toEqual({
      chainId: 84532,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      saleAmount: '10000000',
      merchantTxHash: MERCHANT_TX,
      feeTxHash: FEE_TX,
    });
    expect(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('claim 通知の失敗は決済本体へ波及しない (success を維持・fail-open)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    global.fetch = fetchMock;
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        saleAmount: 10_000_000n,
        registerFee: true,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(result.current.phase).toBe('success');
    expect(result.current.error).toBeNull();
  });

  it('registerFee 印の無い standard は通知しない (従来の /pay・/checkout 経路は不変)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true,"status":"claimed"}'));
    global.fetch = fetchMock;
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 並行 / リトライ / edge state — happy path 外の遷移を全網羅
  // -------------------------------------------------------------------------

  it('fee tx revert (on-chain で reverted): phase=fee-error、merchant 確定は維持', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    // merchant 確定
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    // fee tx broadcast 済 + on-chain で revert (wallet reject ではない)。実際の wagmi は throw し、
    // 生の receipt で reverted を確かめる (A4)。
    publicClientMock.getTransactionReceipt.mockResolvedValue(
      minedReceipt(FEE_TX, 101n, { status: 'reverted' }),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.error = wagmiRevertError();
      useWaitMockState.b.isError = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledWith({
      hash: FEE_TX,
    });
    expect(result.current.isFeeError).toBe(true);
    expect(result.current.isMerchantError).toBe(false);
    expect(result.current.isUnknown).toBe(false);
    // data はまだ undefined (fee tx revert なので success に到達していない)
    expect(result.current.data).toBeUndefined();
    // 既存の fee reverted と同じ後片付け: merchant 確定済みの fee-awaiting に戻し、fee 再送を許す。
    expect(
      JSON.parse(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!),
    ).toMatchObject({
      stage: 'fee-awaiting',
      merchantTxHash: MERCHANT_TX,
      merchantBlockNumber: '100',
    });
    act(() => {
      useWriteContractMockState.b.error = null;
      result.current.retryFee();
    });
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledTimes(2);
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();
  });

  it('paymentLog: fee tx の revert (wagmi は throw) は standard-fee flow に revert 理由つき error で記録される', async () => {
    publicClientMock.getTransactionReceipt.mockResolvedValue(
      minedReceipt(FEE_TX, 101n, { status: 'reverted' }),
    );
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.error = wagmiRevertError();
      useWaitMockState.b.isError = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    await waitFor(() =>
      expect(
        logPaymentEventMock.mock.calls.find(
          (c) => c[0]?.flow === 'standard-fee',
        ),
      ).toBeDefined(),
    );
    const feeLog = logPaymentEventMock.mock.calls.find(
      (c) => c[0]?.flow === 'standard-fee',
    );
    expect(feeLog?.[0]?.result).toBe('error');
    expect(feeLog?.[0]?.errorMessage).toContain('exceeds balance');
    expect(feeLog?.[0]?.txHash).toBe(FEE_TX);
  });

  it('mutate(amount<=0): wallet 連打防御で writeContract が呼ばれない (negative も同じ)', async () => {
    const { result } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: -1n, // negative
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();
    expect(result.current.error?.message).toMatch(/送金額が 0/);
  });

  it('retryFee の冪等性: fee 失敗 → retry 成功で phase=success、merchant tx は再呼出されない', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    // merchant 確定
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce(),
    );
    // fee tx wallet reject
    act(() => {
      useWriteContractMockState.b.error = new Error('user reject 1');
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));

    // retry → fee tx 再送
    act(() => {
      useWriteContractMockState.b.error = null;
      result.current.retryFee();
    });
    rerender();
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledTimes(2);
    // retry の結果も成功
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_TX, 102n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.data?.feeTxHash).toBe(FEE_TX);
    // merchant 側は最初の 1 回限り
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();
  });

  it('retryFee は feeAmount=0 のとき no-op (送信しない、状態変化なし)', async () => {
    const { result } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 199n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 0n,
        chainId: 84532,
      });
    });
    const callsBeforeRetry = useWriteContractMockB.writeContract.mock.calls.length;
    act(() => {
      result.current.retryFee();
    });
    // fee tx は再呼出されない
    expect(useWriteContractMockB.writeContract.mock.calls.length).toBe(callsBeforeRetry);
  });

  it('mutate 連続呼出: 新規パラメタで loggedKey / feeStarted がリセットされ正しく再実行', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    // 1 回目
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 100_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 500n,
        chainId: 84532,
      });
    });
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledTimes(1);
    // 2 回目 (まだ 1 回目の receipt が来ていない状態で別の決済を始める想定)
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 200_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 1000n,
        chainId: 84532,
      });
    });
    rerender();
    // merchant writeContract が再度呼ばれる (新規送金)
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledTimes(2);
    // 2 回目の引数を確認 — 新しい amount で transfer
    const secondCall = useWriteContractMockA.writeContract.mock.calls[1][0];
    expect(secondCall.args).toEqual([MERCHANT, 200_000n]);
  });

  it('phase 派生: feeAmount=0 で merchant 成功時に data が正しく出る (feeTxHash=undefined)', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 100n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 0n, // 極小額で fee 0
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.data?.feeTxHash).toBeUndefined();
    expect(result.current.data?.blockNumber).toBe(100n);
  });

  it('paymentLog: 同一 tx hash で再 render しても log は 1 回限り (dedup gate)', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(
        logPaymentEventMock.mock.calls.filter(
          (c) => c[0]?.flow === 'standard-merchant',
        ).length,
      ).toBe(1),
    );
    // 再 render 連発しても merchant log は 1 回のみ
    rerender();
    rerender();
    rerender();
    expect(
      logPaymentEventMock.mock.calls.filter(
        (c) => c[0]?.flow === 'standard-merchant',
      ).length,
    ).toBe(1);
  });

  it('fee tx broadcast 済 + receipt 待ち: phase が fee-sending → fee-mining に遷移する', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    // merchant 確定 → fee tx 自動起動
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    // fee tx hash 確定 → receipt 待ち (= fee-mining への遷移)
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      // receipt は未確定 (isSuccess=false, isError=false)
    });
    rerender();
    expect(result.current.phase).toBe('fee-mining');
  });

  it('fee receipt RPC エラー: fee-unknown で main Pay/retryFee を封鎖し、fee receipt 再照会で success へ移る', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    // fee tx broadcast 済 + receipt fetch RPC エラー (例: bundler が tx を見失う)
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.error = new Error('rpc receipt fetch failed');
      useWaitMockState.b.isError = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-unknown'));
    expect(result.current.isUnknown).toBe(true);
    expect(result.current.isFeeUnknown).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(result.current.error?.message).toContain('rpc receipt fetch');

    // fee-unknown では fee の新規 tx も merchant の新規 tx も送らない。
    act(() => result.current.retryFee());
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();

    act(() => result.current.retryReceipt());
    expect(useWaitMockState.b.refetch).toHaveBeenCalledOnce();
    expect(useWaitMockState.a.refetch).not.toHaveBeenCalled();

    act(() => {
      useWaitMockState.b.error = null;
      useWaitMockState.b.isError = false;
      useWaitMockState.b.data = minedReceipt(FEE_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.data?.feeTxHash).toBe(FEE_TX);
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce();
  });

  it('merchant 失敗時に paymentLog で result=error が記録される (errorMessage 含む)', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    act(() => {
      useWriteContractMockState.a.error = new Error('AA-21 insufficient funds');
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('merchant-error'));
    const errLog = logPaymentEventMock.mock.calls.find(
      (c) => c[0]?.flow === 'standard-merchant' && c[0]?.result === 'error',
    );
    expect(errLog).toBeDefined();
    expect(errLog?.[0]?.errorMessage).toContain('AA-21');
  });

  // -------------------------------------------------------------------------
  // reload 復元 — broadcast 済み hash を再利用し、新規 transfer を封鎖する
  // -------------------------------------------------------------------------

  it('merchant tx broadcast 時に公開 intent と txHash を sessionStorage へ保存する', async () => {
    const { result } = await renderReadyStandardPayment();
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        saleAmount: 10_000_000n,
        chainId: 84532,
      });
    });

    const onSuccess = useWriteContractMockA.writeContract.mock.calls[0]?.[1]
      ?.onSuccess as ((hash: Hex) => void) | undefined;
    expect(onSuccess).toBeTypeOf('function');
    act(() => onSuccess?.(MERCHANT_TX));

    await waitFor(() => {
      expect(
        window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY),
      ).not.toBeNull();
    });
    const stored = JSON.parse(
      window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!,
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      version: 1,
      chainId: 84532,
      from: CUSTOMER,
      tokenAddress: TOKEN,
      merchant: MERCHANT,
      merchantValue: '9950000',
      feeReceiver: FEE_RECEIVER,
      feeValue: '50000',
      saleValue: '10000000',
      stage: 'merchant',
      merchantTxHash: MERCHANT_TX,
    });
    expect(stored.issuedAt).toEqual(expect.any(Number));
  });

  it('reload: fee retry は別 wallet/未接続で封鎖し、元 payer に戻った時だけ許可する', async () => {
    seedStandardIntent();
    const { result, rerender } = renderHook(() => useStandardPayment());

    expect(result.current.isRestoring).toBe(true);
    await waitFor(() => {
      expect(result.current.isRestoring).toBe(false);
      expect(result.current.phase).toBe('merchant-unknown');
    });
    expect(result.current.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.hasActiveIntent).toBe(true);
    expect(result.current.lastSubmittedParams).toMatchObject({
      merchantAmount: 9_950_000n,
      feeAmount: 50_000n,
      saleAmount: 10_000_000n,
    });

    // broadcast 済み merchant が成立済みかもしれないため、main Pay は再送しない。
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();

    act(() => result.current.retryReceipt());
    expect(useWaitMockState.a.refetch).toHaveBeenCalledOnce();
    act(() => {
      useAccountMock.mockReturnValue({ address: OTHER_CUSTOMER });
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();

    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    expect(result.current.merchantBlockNumber).toBe(100n);
    expect(result.current.restoredFromStorage).toBe(true);
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!,
      ).from,
    ).toBe(CUSTOMER);

    // 別 wallet からは fee leg を開始できず、復元 latch も解除しない。
    act(() => result.current.retryFee());
    rerender();
    expect(result.current.restoredFromStorage).toBe(true);
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();

    // 未接続も同じく no-op。
    act(() => {
      useAccountMock.mockReturnValue({ address: undefined });
    });
    rerender();
    act(() => result.current.retryFee());
    expect(result.current.restoredFromStorage).toBe(true);
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();

    // 元 payer が再接続した明示 retry だけ fee leg を開始する。
    act(() => {
      useAccountMock.mockReturnValue({ address: CUSTOMER });
    });
    rerender();
    act(() => result.current.retryFee());
    rerender();
    expect(result.current.restoredFromStorage).toBe(false);
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce();
    expect(useWriteContractMockB.writeContract.mock.calls[0][0].args).toEqual([
      FEE_RECEIVER,
      50_000n,
    ]);
  });

  it('reload: fee txHash を unknown として復元し、receipt 成功まで全 transfer を封鎖する', async () => {
    seedStandardIntent({
      stage: 'fee',
      feeTxHash: FEE_TX,
      merchantBlockNumber: '100',
    });
    const { result, rerender } = renderHook(() => useStandardPayment());
    // storage 読込完了前に届いた submit も、復元成功後に遅延送信してはならない。
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });

    await waitFor(() => {
      expect(result.current.isRestoring).toBe(false);
      expect(result.current.phase).toBe('fee-unknown');
    });
    expect(result.current.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.feeTxHash).toBe(FEE_TX);

    act(() => result.current.retryFee());
    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        merchantAmount: 9_950_000n,
        feeReceiver: FEE_RECEIVER,
        feeAmount: 50_000n,
        chainId: 84532,
      });
    });
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();

    act(() => result.current.retryReceipt());
    expect(useWaitMockState.b.refetch).toHaveBeenCalledOnce();
    act(() => {
      useWaitMockState.b.data = minedReceipt(FEE_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();

    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.data).toEqual({
      merchantTxHash: MERCHANT_TX,
      feeTxHash: FEE_TX,
      blockNumber: 100n,
    });
    expect(
      window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY),
    ).toBeNull();
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
  });

  it('reload: fee tx の reverted 確定後だけ fee retry を許可し、merchant は再送しない', async () => {
    seedStandardIntent({
      stage: 'fee',
      feeTxHash: FEE_TX,
      merchantBlockNumber: '100',
    });
    const { result, rerender } = renderHook(() => useStandardPayment());
    await waitFor(() => expect(result.current.phase).toBe('fee-unknown'));

    // 実際の wagmi は revert で throw する。生の receipt で reverted を確かめたときだけ抜ける。
    publicClientMock.getTransactionReceipt.mockResolvedValue(
      minedReceipt(FEE_TX, 101n, { status: 'reverted' }),
    );
    act(() => {
      useWaitMockState.b.error = wagmiRevertError();
      useWaitMockState.b.isError = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    expect(result.current.feeTxHash).toBeUndefined();

    const storedAfterRevert = JSON.parse(
      window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!,
    ) as Record<string, unknown>;
    expect(storedAfterRevert).toMatchObject({
      stage: 'fee-awaiting',
      merchantTxHash: MERCHANT_TX,
      merchantBlockNumber: '100',
    });
    expect(storedAfterRevert.feeTxHash).toBeUndefined();

    act(() => result.current.retryFee());
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 第 7 回レビュー A1: 置換 tx (同じ nonce の高速化 / 取消) の receipt
// viem は置換を見つけると置換 tx の receipt で resolve する。transactionHash が送信 hash と違う
// receipt は「元の送金の成功」ではない。置換 tx の log に同じ Transfer があるときだけ同内容
// (高速化) として成功にし、以後の hash は実際に mine された hash を使う。
// ---------------------------------------------------------------------------
describe('useStandardPayment: 置換 tx の receipt (A1)', () => {
  const OTHER_TOKEN: Address = '0x2222222222222222222222222222222222222222';
  const params = {
    tokenAddress: TOKEN,
    merchant: MERCHANT,
    merchantAmount: 9_950_000n,
    feeReceiver: FEE_RECEIVER,
    feeAmount: 50_000n,
    chainId: 84532,
  };

  function merchantLogs() {
    return logPaymentEventMock.mock.calls
      .map((call) => call[0])
      .filter((event) => event?.flow === 'standard-merchant');
  }

  it('merchant tx が取消 (Transfer なし) に置換されたら成功にせず merchant-error・fee を送らない', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => result.current.mutate(params));
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_REPLACEMENT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();

    await waitFor(() => expect(result.current.phase).toBe('merchant-error'));
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isMerchantError).toBe(true);
    expect(result.current.data).toBeUndefined();
    // 取消 tx の block を「店舗着金の block」として外へ出さない (履歴の補完 append を防ぐ)。
    expect(result.current.merchantBlockNumber).toBeUndefined();
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
    // 既存の確定失敗 (reverted) と同じ後片付け: intent を消す。
    expect(result.current.hasActiveIntent).toBe(false);
    expect(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)).toBeNull();

    // 店舗に着金していないので fee の手動再送も開けない。
    act(() => result.current.retryFee());
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();

    // 決済ログに success を残さない (error として残す)。
    await waitFor(() =>
      expect(merchantLogs().some((e) => e?.result === 'error')).toBe(true),
    );
    expect(merchantLogs().some((e) => e?.result === 'success')).toBe(false);

    // 取消は元の送金を永久に無効にするので、次の決済はそのまま始められる。
    act(() => result.current.mutate(params));
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['別の宛先', transferLog(OTHER_CUSTOMER, 9_950_000n)],
    ['別の金額', transferLog(MERCHANT, 9_949_999n)],
    ['別の token', transferLog(MERCHANT, 9_950_000n, { token: OTHER_TOKEN })],
    ['別の送り主', transferLog(MERCHANT, 9_950_000n, { from: OTHER_CUSTOMER })],
  ])('merchant tx の置換が別内容 (%s の Transfer) なら merchant-error', async (_label, log) => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => result.current.mutate(params));
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_REPLACEMENT_TX, 100n, {
        logs: [log],
      });
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('merchant-error'));
    expect(result.current.data).toBeUndefined();
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
  });

  it('同内容の置換 (高速化) は成功・保存/fee/結果/レジ通知/ログの hash は実際に mine された hash', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true,"status":"claimed"}'));
    global.fetch = fetchMock;
    const { result, rerender } = await renderReadyStandardPayment();
    act(() =>
      result.current.mutate({
        ...params,
        saleAmount: 10_000_000n,
        registerFee: true,
      }),
    );
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_REPLACEMENT_TX, 100n, {
        // 同じ wallet の同じ transfer が gas だけ変えて mine された (無関係な log が混じっても可)。
        logs: [
          transferLog(MERCHANT, 1n, { token: OTHER_TOKEN }),
          transferLog(MERCHANT, 9_950_000n),
        ],
      });
      useWaitMockState.a.isSuccess = true;
    });
    rerender();

    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce(),
    );
    expect(result.current.phase).toBe('fee-sending');
    expect(result.current.merchantTxHash).toBe(MERCHANT_REPLACEMENT_TX);
    expect(result.current.merchantBlockNumber).toBe(100n);
    expect(
      JSON.parse(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!),
    ).toMatchObject({
      stage: 'fee-awaiting',
      merchantTxHash: MERCHANT_REPLACEMENT_TX,
      merchantBlockNumber: '100',
    });

    // fee broadcast の保存も実 hash に紐づける。
    const onFeeSuccess = useWriteContractMockB.writeContract.mock.calls[0]?.[1]
      ?.onSuccess as ((hash: Hex) => void) | undefined;
    act(() => onFeeSuccess?.(FEE_TX));
    expect(
      JSON.parse(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!),
    ).toMatchObject({
      stage: 'fee',
      merchantTxHash: MERCHANT_REPLACEMENT_TX,
      feeTxHash: FEE_TX,
    });

    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.data).toEqual({
      merchantTxHash: MERCHANT_REPLACEMENT_TX,
      feeTxHash: FEE_TX,
      blockNumber: 100n,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toMatchObject({ merchantTxHash: MERCHANT_REPLACEMENT_TX, feeTxHash: FEE_TX });
    await waitFor(() =>
      expect(
        merchantLogs().some(
          (e) => e?.result === 'success' && e?.txHash === MERCHANT_REPLACEMENT_TX,
        ),
      ).toBe(true),
    );
    expect(
      merchantLogs().some(
        (e) => e?.result === 'success' && e?.txHash === MERCHANT_TX,
      ),
    ).toBe(false);
  });

  it('fee=0 の同内容置換: success で data.merchantTxHash は実際に mine された hash', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => result.current.mutate({ ...params, feeAmount: 0n }));
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_REPLACEMENT_TX, 100n, {
        logs: [transferLog(MERCHANT, 9_950_000n)],
      });
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.data).toEqual({
      merchantTxHash: MERCHANT_REPLACEMENT_TX,
      feeTxHash: undefined,
      blockNumber: 100n,
    });
    expect(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)).toBeNull();
  });

  async function confirmMerchantThenSendFee() {
    const hook = await renderReadyStandardPayment();
    act(() =>
      hook.result.current.mutate({
        ...params,
        saleAmount: 10_000_000n,
        registerFee: true,
      }),
    );
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    hook.rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce(),
    );
    return hook;
  }

  it('fee tx が取消に置換されたら成功にせず fee-error (merchant 確定は維持・fee 再送は可)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    global.fetch = fetchMock;
    const { result, rerender } = await confirmMerchantThenSendFee();
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_REPLACEMENT_TX, 101n);
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.merchantBlockNumber).toBe(100n);
    // 既存の fee reverted と同じ後片付け (fee-awaiting に戻す)。
    expect(
      JSON.parse(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)!),
    ).toMatchObject({
      stage: 'fee-awaiting',
      merchantTxHash: MERCHANT_TX,
      merchantBlockNumber: '100',
    });
    // 取消された fee tx でレジの用途通知を撃たない。
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      useWriteContractMockState.b.error = null;
      result.current.retryFee();
    });
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledTimes(2);
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();
  });

  it('fee tx の同内容置換は success・feeTxHash とレジ通知は実際に mine された hash', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true,"status":"claimed"}'));
    global.fetch = fetchMock;
    const { result, rerender } = await confirmMerchantThenSendFee();
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = minedReceipt(FEE_REPLACEMENT_TX, 101n, {
        logs: [transferLog(FEE_RECEIVER, 50_000n)],
      });
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.feeTxHash).toBe(FEE_REPLACEMENT_TX);
    expect(result.current.data).toEqual({
      merchantTxHash: MERCHANT_TX,
      feeTxHash: FEE_REPLACEMENT_TX,
      blockNumber: 100n,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)),
    ).toMatchObject({ merchantTxHash: MERCHANT_TX, feeTxHash: FEE_REPLACEMENT_TX });
  });
});

// ---------------------------------------------------------------------------
// 第 7 回レビュー A4: wagmi の receipt query error は「通信障害」と「revert」を区別できない
// (実際の wagmi は revert でも throw する)。生の receipt で reverted を確かめたときだけ確定失敗へ。
// ---------------------------------------------------------------------------
describe('useStandardPayment: receipt query error の終端判定 (A4)', () => {
  const params = {
    tokenAddress: TOKEN,
    merchant: MERCHANT,
    merchantAmount: 9_950_000n,
    feeReceiver: FEE_RECEIVER,
    feeAmount: 50_000n,
    chainId: 84532,
  };

  it.each([
    ['RPC 障害', () => Promise.reject(new Error('rpc down'))],
    [
      '未 mine (receipt 無し)',
      () =>
        Promise.reject(
          Object.assign(new Error('receipt not found'), {
            name: 'TransactionReceiptNotFoundError',
          }),
        ),
    ],
    ['success (revert ではない)', () => Promise.resolve(minedReceipt(MERCHANT_TX, 100n))],
  ])('merchant: 生の receipt が %s なら merchant-unknown のまま (再送を開けない)', async (_label, impl) => {
    publicClientMock.getTransactionReceipt.mockImplementation(impl);
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => result.current.mutate(params));
    // broadcast 時の intent 保存 (wallet が hash を返した時点)。
    const onMerchantSuccess = useWriteContractMockA.writeContract.mock.calls[0]?.[1]
      ?.onSuccess as ((hash: Hex) => void) | undefined;
    act(() => onMerchantSuccess?.(MERCHANT_TX));
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.error = new Error('merchant receipt rpc timeout');
      useWaitMockState.a.isError = true;
    });
    rerender();
    await waitFor(() =>
      expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledOnce(),
    );
    // probe の解決を待ってから、状態が変わっていないことを確かめる。
    await act(async () => {
      await Promise.resolve();
    });
    rerender();
    expect(result.current.phase).toBe('merchant-unknown');
    expect(result.current.isMerchantError).toBe(false);
    expect(result.current.hasActiveIntent).toBe(true);
    // 同じ error では生 receipt を 1 回だけ引く (render のたびに RPC を叩かない)。
    expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledOnce();
    act(() => result.current.mutate(params));
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();
  });

  it('fee: 生の receipt が取れなければ fee-unknown のまま (fee を再送しない)', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => result.current.mutate(params));
    act(() => {
      useWriteContractMockState.a.data = MERCHANT_TX;
      useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 100n);
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce(),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.error = new Error('fee receipt rpc timeout');
      useWaitMockState.b.isError = true;
    });
    rerender();
    await waitFor(() =>
      expect(publicClientMock.getTransactionReceipt).toHaveBeenCalledWith({
        hash: FEE_TX,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender();
    expect(result.current.phase).toBe('fee-unknown');
    act(() => result.current.retryFee());
    expect(useWriteContractMockB.writeContract).toHaveBeenCalledOnce();
  });
});

describe('disabled standard payments', () => {
  it('a populated session is neither restored nor rewritten, queried or logged', async () => {
    seedStandardIntent();
    const stored = window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY);
    const { result, rerender } = renderHook(() => useStandardPayment({ enabled: false }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.hasAttempt).toBe(false);
    expect(result.current.isRestoring).toBe(false);
    act(() => result.current.mutate({ chainId: 84532, tokenAddress: TOKEN, merchant: MERCHANT, merchantAmount: 1n, feeReceiver: FEE_RECEIVER, feeAmount: 0n }));
    act(() => result.current.retryReceipt());
    rerender();
    expect(useWriteContractMockA.writeContract).not.toHaveBeenCalled();
    expect(useWaitMockState.a.refetch).not.toHaveBeenCalled();
    expect(logPaymentEventMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STANDARD_INTENT_STORAGE_KEY)).toBe(stored);
  });
  it('tip log payer is snapshotted across wallet switches', async () => {
    const { result, rerender } = await renderReadyStandardPayment();
    act(() => result.current.mutate({ chainId: 5042002, tokenAddress: TOKEN, merchant: MERCHANT, merchantAmount: 500000n, feeReceiver: FEE_RECEIVER, feeAmount: 0n, customer: CUSTOMER, tip: true, chainSlug: 'arc', mode: 'standard' }));
    useAccountMock.mockReturnValue({ address: OTHER_CUSTOMER });
    useWriteContractMockState.a.data = MERCHANT_TX;
    useWaitMockState.a.data = minedReceipt(MERCHANT_TX, 123n);
    useWaitMockState.a.isSuccess = true;
    rerender();
    await waitFor(() => expect(logPaymentEventMock).toHaveBeenCalledWith(expect.objectContaining({ tip: true, chainSlug: 'arc', mode: 'standard', customer: CUSTOMER })));
  });
});
