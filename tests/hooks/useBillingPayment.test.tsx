import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// wagmi の useWriteContract / useWaitForTransactionReceipt は外部依存。hoisted ホルダで
// 戻り値を差し替え、フェーズ遷移ロジック (=テスト対象) は実コードを走らせる。
const w = vi.hoisted(() => ({
  writeContract: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  data: undefined as `0x${string}` | undefined,
  error: null as Error | null,
}));
const r = vi.hoisted(() => ({
  isSuccess: false,
  isError: false,
  data: undefined as { status: 'success' | 'reverted' } | undefined,
  error: null as Error | null,
}));

vi.mock('wagmi', () => ({
  useWriteContract: () => w,
  useWaitForTransactionReceipt: () => r,
}));

import { useBillingPayment } from '@/hooks/useBillingPayment';
import { erc20Abi } from 'viem';

const TX = `0x${'a'.repeat(64)}` as `0x${string}`;
const TOKEN = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AMOUNT = 300n * 10n ** 18n;
const CHAIN = 80002;

function resetWagmi() {
  w.writeContract = vi.fn();
  w.reset = vi.fn();
  w.isPending = false;
  w.data = undefined;
  w.error = null;
  r.isSuccess = false;
  r.isError = false;
  r.data = undefined;
  r.error = null;
}

beforeEach(resetWagmi);

describe('useBillingPayment', () => {
  it('初期状態は idle', () => {
    const { result } = renderHook(() => useBillingPayment());
    expect(result.current.phase).toBe('idle');
    expect(result.current.isSending).toBe(false);
    expect(result.current.isConfirmed).toBe(false);
    expect(result.current.txHash).toBeUndefined();
  });

  it('pay() で sending へ・writeContract に正しい erc20 transfer 引数', () => {
    const { result } = renderHook(() => useBillingPayment());
    act(() => {
      result.current.pay({ tokenAddress: TOKEN, to: TO, amount: AMOUNT, chainId: CHAIN });
    });
    expect(result.current.phase).toBe('sending');
    expect(result.current.isSending).toBe(true);
    expect(w.reset).toHaveBeenCalledOnce(); // 前回 tx をクリア
    expect(w.writeContract).toHaveBeenCalledWith({
      chainId: CHAIN,
      address: TOKEN,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [TO, AMOUNT],
    });
  });

  it('sending → tx hash 確定 (receipt 待ち) で mining', () => {
    const { result, rerender } = renderHook(() => useBillingPayment());
    act(() => {
      result.current.pay({ tokenAddress: TOKEN, to: TO, amount: AMOUNT, chainId: CHAIN });
    });
    // wallet 署名完了 → txHash が出るが receipt はまだ
    act(() => {
      w.data = TX;
      rerender();
    });
    expect(result.current.phase).toBe('mining');
    expect(result.current.isMining).toBe(true);
    expect(result.current.txHash).toBe(TX);
  });

  it('mining → receipt success(status=success) で confirmed', () => {
    const { result, rerender } = renderHook(() => useBillingPayment());
    act(() => {
      result.current.pay({ tokenAddress: TOKEN, to: TO, amount: AMOUNT, chainId: CHAIN });
    });
    act(() => {
      w.data = TX;
      rerender();
    });
    act(() => {
      r.isSuccess = true;
      r.data = { status: 'success' };
      rerender();
    });
    expect(result.current.phase).toBe('confirmed');
    expect(result.current.isConfirmed).toBe(true);
    expect(result.current.txHash).toBe(TX);
  });

  it('write error → error フェーズ + error を passthrough', () => {
    const { result, rerender } = renderHook(() => useBillingPayment());
    act(() => {
      result.current.pay({ tokenAddress: TOKEN, to: TO, amount: AMOUNT, chainId: CHAIN });
    });
    const err = new Error('user rejected');
    act(() => {
      w.error = err;
      rerender();
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.isError).toBe(true);
    expect(result.current.error).toBe(err);
  });

  it('receipt error (RPC 失敗等) → error フェーズ', () => {
    const { result, rerender } = renderHook(() => useBillingPayment());
    act(() => {
      result.current.pay({ tokenAddress: TOKEN, to: TO, amount: AMOUNT, chainId: CHAIN });
    });
    act(() => {
      w.data = TX;
      rerender();
    });
    const err = new Error('receipt timeout');
    act(() => {
      r.isError = true; // wagmi は isError と error を同時に立てる
      r.error = err;
      rerender();
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe(err);
  });

  it('receipt success だが status=reverted → error (confirmed にしない)', () => {
    const { result, rerender } = renderHook(() => useBillingPayment());
    act(() => {
      result.current.pay({ tokenAddress: TOKEN, to: TO, amount: AMOUNT, chainId: CHAIN });
    });
    act(() => {
      w.data = TX;
      rerender();
    });
    act(() => {
      r.isSuccess = true;
      r.data = { status: 'reverted' };
      rerender();
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.isConfirmed).toBe(false);
  });

  it('reset() で idle に戻し write.reset も呼ぶ', () => {
    const { result, rerender } = renderHook(() => useBillingPayment());
    act(() => {
      result.current.pay({ tokenAddress: TOKEN, to: TO, amount: AMOUNT, chainId: CHAIN });
    });
    act(() => {
      w.data = TX;
      r.isSuccess = true;
      r.data = { status: 'success' };
      rerender();
    });
    expect(result.current.phase).toBe('confirmed');
    const resetSpy = w.reset;
    act(() => {
      result.current.reset();
    });
    expect(result.current.phase).toBe('idle');
    expect(resetSpy).toHaveBeenCalled();
  });
});
