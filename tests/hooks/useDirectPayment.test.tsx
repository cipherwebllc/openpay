import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { erc20Abi, getAddress, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';

// wagmi の writeContract / waitForTransactionReceipt のみ境界モック。
// useDirectPayment 本体のロジック (引数組立 / 状態遷移) は実コードで検証する。
vi.mock('wagmi', () => ({
  useWriteContract: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
}));
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { useDirectPayment } from '@/hooks/useDirectPayment';

const TOKEN: Address = getAddress(
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
);
const MERCHANT: Address = getAddress(
  '0x1111111111111111111111111111111111111111',
);

let writeContract: ReturnType<typeof vi.fn>;

function mockWrite(opts: {
  data?: Hex;
  isPending?: boolean;
  isSuccess?: boolean;
  error?: Error | null;
}) {
  writeContract = vi.fn();
  vi.mocked(useWriteContract).mockReturnValue({
    writeContract,
    data: opts.data,
    isPending: opts.isPending ?? false,
    isSuccess: opts.isSuccess ?? false,
    error: opts.error ?? null,
  } as never);
}

function mockReceipt(opts: {
  data?: { blockNumber: bigint };
  isSuccess?: boolean;
  isError?: boolean;
  error?: Error | null;
  isLoading?: boolean;
}) {
  vi.mocked(useWaitForTransactionReceipt).mockReturnValue({
    data: opts.data,
    isSuccess: opts.isSuccess ?? false,
    isError: opts.isError ?? false,
    error: opts.error ?? null,
    isLoading: opts.isLoading ?? false,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWrite({});
  mockReceipt({});
});

describe('useDirectPayment', () => {
  it('mutate で writeContract が ERC20.transfer 引数で呼ばれる', () => {
    const { result } = renderHook(() => useDirectPayment());

    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        amount: 50_000_000n,
        chainId: baseSepolia.id,
      });
    });

    expect(writeContract).toHaveBeenCalledOnce();
    const arg = writeContract.mock.calls[0][0];
    expect(arg.address.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(arg.abi).toBe(erc20Abi);
    expect(arg.functionName).toBe('transfer');
    expect(arg.args[0].toLowerCase()).toBe(MERCHANT.toLowerCase());
    expect(arg.args[1]).toBe(50_000_000n);
    expect(arg.chainId).toBe(baseSepolia.id);
  });

  it('amount = 0: writeContract は呼ばれず error が立つ', () => {
    const { result } = renderHook(() => useDirectPayment());

    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        amount: 0n,
        chainId: baseSepolia.id,
      });
    });

    expect(writeContract).not.toHaveBeenCalled();
    expect(result.current.error?.message).toMatch(/0|送金額/);
    expect(result.current.isError).toBe(true);
  });

  it('write 中: isPending = true', () => {
    mockWrite({ isPending: true });
    const { result } = renderHook(() => useDirectPayment());
    expect(result.current.isPending).toBe(true);
  });

  it('write 完了 + receipt 待ち: isPending = true', () => {
    mockWrite({ isSuccess: true, data: `0x${'a'.repeat(64)}` as Hex });
    mockReceipt({ isSuccess: false, isError: false });
    const { result } = renderHook(() => useDirectPayment());
    expect(result.current.isPending).toBe(true);
    expect(result.current.isSuccess).toBe(false);
  });

  it('receipt 確定: data に txHash と blockNumber が入る', () => {
    const txHash = `0x${'a'.repeat(64)}` as Hex;
    mockWrite({ isSuccess: true, data: txHash });
    mockReceipt({ isSuccess: true, data: { blockNumber: 99n } });
    const { result } = renderHook(() => useDirectPayment());
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data?.txHash).toBe(txHash);
    expect(result.current.data?.blockNumber).toBe(99n);
  });

  it('writeContract のエラーが error に伝播', () => {
    const e = new Error('user rejected request');
    mockWrite({ error: e });
    const { result } = renderHook(() => useDirectPayment());
    expect(result.current.error?.message).toBe('user rejected request');
    expect(result.current.isError).toBe(true);
  });

  it('receipt のエラーが error に伝播', () => {
    const e = new Error('replacement transaction underpriced');
    mockWrite({ isSuccess: true, data: `0x${'b'.repeat(64)}` as Hex });
    mockReceipt({ isError: true, error: e });
    const { result } = renderHook(() => useDirectPayment());
    expect(result.current.error?.message).toMatch(/replacement/);
  });

  it('mutate を再実行すると externalError がリセットされる', async () => {
    const { result } = renderHook(() => useDirectPayment());

    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        amount: 0n,
        chainId: baseSepolia.id,
      });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    act(() => {
      result.current.mutate({
        tokenAddress: TOKEN,
        merchant: MERCHANT,
        amount: 100n,
        chainId: baseSepolia.id,
      });
    });
    await waitFor(() => {
      expect(result.current.error?.message).toBeFalsy();
    });
    expect(writeContract).toHaveBeenCalledOnce();
  });
});
