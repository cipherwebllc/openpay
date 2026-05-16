import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Address, Hex } from 'viem';

// wagmi の useAccount / useWriteContract / useWaitForTransactionReceipt を境界モック。
// useStandardPayment 本体のロジック (phase 遷移 / 2-tx 直列 / retry / log) は実コードを走らせる。
const useAccountMock = vi.fn();
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
    data: undefined as
      | { status: 'success' | 'reverted'; blockNumber: bigint }
      | undefined,
    error: null as Error | null,
    isSuccess: false,
    isError: false,
  },
  b: {
    data: undefined as
      | { status: 'success' | 'reverted'; blockNumber: bigint }
      | undefined,
    error: null as Error | null,
    isSuccess: false,
    isError: false,
  },
};
// useWriteContract は 2 回呼ばれる (merchant / fee 用)。順序で振り分け。
let writeCallCount = 0;
vi.mock('wagmi', () => ({
  useAccount: () => useAccountMock(),
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
    if (hash === useWriteContractMockState.a.data && hash !== undefined) {
      return useWaitMockState.a;
    }
    if (hash === useWriteContractMockState.b.data && hash !== undefined) {
      return useWaitMockState.b;
    }
    return {
      data: undefined,
      error: null,
      isSuccess: false,
      isError: false,
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
const MERCHANT_TX: Hex = `0x${'a'.repeat(64)}`;
const FEE_TX: Hex = `0x${'b'.repeat(64)}`;

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
  useWaitMockState.b.data = undefined;
  useWaitMockState.b.error = null;
  useWaitMockState.b.isSuccess = false;
  useWaitMockState.b.isError = false;
  logPaymentEventMock.mockReset();
  useAccountMock.mockReturnValue({ address: CUSTOMER });
}

beforeEach(() => {
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

  it('idle 状態: phase=idle、isPending/isSuccess/isError 全 false、data=undefined', () => {
    const { result } = renderHook(() => useStandardPayment());
    expect(result.current.phase).toBe('idle');
    expect(result.current.isPending).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('mutate(merchantAmount=0): pre-validation で reject、writeContract は呼ばれない', () => {
    const { result } = renderHook(() => useStandardPayment());
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

  it('mutate(): merchant tx を発火、phase=merchant-sending', () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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

  it('merchant tx revert: phase=merchant-error', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'reverted', blockNumber: 100n };
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => {
      expect(result.current.phase).toBe('merchant-error');
    });
    // fee tx は発火しない (merchant が revert したので)
    expect(useWriteContractMockB.writeContract).not.toHaveBeenCalled();
  });

  it('fee tx 失敗 (wallet reject): phase=fee-error、merchant 確定済 = data には merchant hash あり', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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
  });

  it('retryFee(): fee tx を再送信、merchant tx は再呼び出ししない', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = { status: 'success', blockNumber: 101n };
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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

  // -------------------------------------------------------------------------
  // 並行 / リトライ / edge state — happy path 外の遷移を全網羅
  // -------------------------------------------------------------------------

  it('fee tx revert (on-chain で reverted): phase=fee-error、merchant 確定は維持', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    // fee tx broadcast 済 + receipt status='reverted' (on-chain で失敗、wallet reject ではない)
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = { status: 'reverted', blockNumber: 101n };
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    expect(result.current.isFeeError).toBe(true);
    expect(result.current.isMerchantError).toBe(false);
    // data はまだ undefined (fee tx revert なので success に到達していない)
    expect(result.current.data).toBeUndefined();
  });

  it('paymentLog: fee tx reverted で result=reverted が standard-fee flow で記録される', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() =>
      expect(useWriteContractMockB.writeContract).toHaveBeenCalled(),
    );
    act(() => {
      useWriteContractMockState.b.data = FEE_TX;
      useWaitMockState.b.data = { status: 'reverted', blockNumber: 101n };
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    const feeLog = logPaymentEventMock.mock.calls.find(
      (c) => c[0]?.flow === 'standard-fee',
    );
    expect(feeLog).toBeDefined();
    expect(feeLog?.[0]?.result).toBe('reverted');
    expect(feeLog?.[0]?.txHash).toBe(FEE_TX);
  });

  it('mutate(amount<=0): wallet 連打防御で writeContract が呼ばれない (negative も同じ)', () => {
    const { result } = renderHook(() => useStandardPayment());
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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
      useWaitMockState.b.data = { status: 'success', blockNumber: 102n };
      useWaitMockState.b.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('success'));
    expect(result.current.data?.feeTxHash).toBe(FEE_TX);
    // merchant 側は最初の 1 回限り
    expect(useWriteContractMockA.writeContract).toHaveBeenCalledOnce();
  });

  it('retryFee は feeAmount=0 のとき no-op (送信しない、状態変化なし)', () => {
    const { result } = renderHook(() => useStandardPayment());
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
      useWaitMockState.a.isSuccess = true;
    });
    rerender();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.merchantTxHash).toBe(MERCHANT_TX);
    expect(result.current.data?.feeTxHash).toBeUndefined();
    expect(result.current.data?.blockNumber).toBe(100n);
  });

  it('paymentLog: 同一 tx hash で再 render しても log は 1 回限り (dedup gate)', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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

  it('fee receipt RPC エラー: phase=fee-error、wallet エラーとは別経路で記録', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
      useWaitMockState.a.data = { status: 'success', blockNumber: 100n };
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
    await waitFor(() => expect(result.current.phase).toBe('fee-error'));
    // error はそのまま伝播
    expect(result.current.error?.message).toContain('rpc receipt fetch');
  });

  it('merchant 失敗時に paymentLog で result=error が記録される (errorMessage 含む)', async () => {
    const { result, rerender } = renderHook(() => useStandardPayment());
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
});
