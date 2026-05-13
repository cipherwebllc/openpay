import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { erc20Abi, getAddress, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';

// wagmi の writeContract / waitForTransactionReceipt のみ境界モック。
// useDirectPayment 本体のロジック (引数組立 / 状態遷移) は実コードで検証する。
vi.mock('wagmi', () => ({
  useWriteContract: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
  useAccount: vi.fn(() => ({ address: undefined, isConnected: false })),
}));
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { useDirectPayment } from '@/hooks/useDirectPayment';
import { mockHook } from '../_helpers/wagmiMock';

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
  mockHook(useWriteContract, {
    writeContract,
    data: opts.data,
    isPending: opts.isPending ?? false,
    isSuccess: opts.isSuccess ?? false,
    error: opts.error ?? null,
  } as Partial<ReturnType<typeof useWriteContract>>);
}

function mockReceipt(opts: {
  data?: { blockNumber: bigint };
  isSuccess?: boolean;
  isError?: boolean;
  error?: Error | null;
  isLoading?: boolean;
}) {
  mockHook(useWaitForTransactionReceipt, {
    data: opts.data,
    isSuccess: opts.isSuccess ?? false,
    isError: opts.isError ?? false,
    error: opts.error ?? null,
    isLoading: opts.isLoading ?? false,
  } as Partial<ReturnType<typeof useWaitForTransactionReceipt>>);
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

  describe('payment log effect (実コード経由で fetch を発火)', () => {
    const TX = `0x${'c'.repeat(64)}` as Hex;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn().mockResolvedValue(
        new Response(null, { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      vi.mocked(useAccount).mockReturnValue({
        address: '0x9999999999999999999999999999999999999999',
        isConnected: true,
      } as unknown as ReturnType<typeof useAccount>);
    });

    function mountAndMutate() {
      mockWrite({});
      mockReceipt({});
      const view = renderHook(() => useDirectPayment());
      act(() => {
        view.result.current.mutate({
          tokenAddress: TOKEN,
          merchant: MERCHANT,
          amount: 500n,
          chainId: baseSepolia.id,
        });
      });
      return view;
    }

    it('receipt success → fetch が success payload で呼ばれる', async () => {
      const view = mountAndMutate();
      mockWrite({ isSuccess: true, data: TX });
      mockReceipt({
        isSuccess: true,
        data: { blockNumber: 42n, status: 'success' } as unknown as {
          blockNumber: bigint;
        },
      });
      view.rerender();

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/log/payment');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        flow: 'direct',
        result: 'success',
        chainId: baseSepolia.id,
        merchant: MERCHANT.toLowerCase(),
        merchantAmount: '500',
        txHash: TX,
        blockNumber: '42',
        customer: '0x9999999999999999999999999999999999999999',
      });
      expect(body.userOpHash).toBeUndefined();
      expect(body.feeAmount).toBeUndefined();
    });

    it('receipt status=reverted → result=reverted で送信', async () => {
      const view = mountAndMutate();
      mockWrite({ isSuccess: true, data: TX });
      mockReceipt({
        isSuccess: true,
        data: { blockNumber: 1n, status: 'reverted' } as unknown as {
          blockNumber: bigint;
        },
      });
      view.rerender();

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.result).toBe('reverted');
      expect(body.txHash).toBe(TX);
    });

    it('writeContract が reject → fetch が error payload (txHash なし) で呼ばれる', async () => {
      const view = mountAndMutate();
      mockWrite({ error: new Error('user rejected request') });
      mockReceipt({});
      view.rerender();

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toMatchObject({
        flow: 'direct',
        result: 'error',
        errorMessage: 'user rejected request',
      });
      expect(body.txHash).toBeUndefined();
    });

    it('write 後の receipt 段階で error → txHash を含む error payload', async () => {
      const view = mountAndMutate();
      mockWrite({ isSuccess: true, data: TX });
      mockReceipt({ isError: true, error: new Error('reorg') });
      view.rerender();

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.result).toBe('error');
      expect(body.errorMessage).toBe('reorg');
      expect(body.txHash).toBe(TX);
    });

    it('rerender を繰り返しても同一 mutate に対して fetch は 1 度のみ (dedup)', async () => {
      const view = mountAndMutate();
      mockWrite({ isSuccess: true, data: TX });
      mockReceipt({
        isSuccess: true,
        data: { blockNumber: 7n, status: 'success' } as unknown as {
          blockNumber: bigint;
        },
      });
      view.rerender();
      view.rerender();
      view.rerender();

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      // dep が同一参照なら effect は再 fire しないが、念のため guard も検証
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('mutate せずに state が変化しても fetch は呼ばれない (lastParams guard)', async () => {
      mockWrite({ isSuccess: true, data: TX });
      mockReceipt({
        isSuccess: true,
        data: { blockNumber: 1n, status: 'success' } as unknown as {
          blockNumber: bigint;
        },
      });
      renderHook(() => useDirectPayment());
      // 100ms 程度待っても fetch は発火しない
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('mutate 2 回目 (異なる tx) で新 fetch が発火 (loggedKey reset)', async () => {
      const TX1 = `0x${'1'.repeat(64)}` as Hex;
      const TX2 = `0x${'2'.repeat(64)}` as Hex;
      const view = mountAndMutate();

      // 1 回目: TX1 で success
      mockWrite({ isSuccess: true, data: TX1 });
      mockReceipt({
        isSuccess: true,
        data: { blockNumber: 1n, status: 'success' } as unknown as {
          blockNumber: bigint;
        },
      });
      view.rerender();
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      // 2 回目 mutate
      act(() => {
        view.result.current.mutate({
          tokenAddress: TOKEN,
          merchant: MERCHANT,
          amount: 1000n,
          chainId: baseSepolia.id,
        });
      });
      mockWrite({ isSuccess: true, data: TX2 });
      mockReceipt({
        isSuccess: true,
        data: { blockNumber: 2n, status: 'success' } as unknown as {
          blockNumber: bigint;
        },
      });
      view.rerender();
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

      const body2 = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body2.txHash).toBe(TX2);
      expect(body2.merchantAmount).toBe('1000');
    });
  });
});

import { useAccount } from 'wagmi';
