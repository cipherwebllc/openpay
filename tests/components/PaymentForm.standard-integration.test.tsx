// 統合テスト: PaymentForm + 実 useStandardPayment + wagmi のみ mock。
// 単体テスト側 (PaymentForm.test.tsx) は useStandardPayment 全体を mock しているため、
// hook の出力 shape ⇄ form の消費の wiring は型一致のみで保証されている。本テストは
// hook を実コードで走らせ、shape drift を catch する。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { baseSepolia } from 'viem/chains';
import type { Address, Hex } from 'viem';

// wagmi useWriteContract は引数を取らないため、call 順序 (merchant 先、fee 後) で
// 識別する。hook 側で順序が入れ替わると silent に壊れる点に注意。
const writeMocks = {
  merchant: {
    writeContract: vi.fn(),
    reset: vi.fn(),
    data: undefined as Hex | undefined,
    error: null as Error | null,
    isPending: false,
  },
  fee: {
    writeContract: vi.fn(),
    reset: vi.fn(),
    data: undefined as Hex | undefined,
    error: null as Error | null,
    isPending: false,
  },
};

const receiptMocks = {
  // hash → receipt 状態 のマップ。useWaitForTransactionReceipt({ hash }) に応じて返す。
  byHash: new Map<
    Hex,
    {
      data: { status: 'success' | 'reverted'; blockNumber: bigint } | undefined;
      error: Error | null;
      isSuccess: boolean;
      isError: boolean;
    }
  >(),
};

let writeCallIdx = 0;
const accountMock = vi.fn();
const switchChainMock = vi.fn();
const readContractMock = vi.fn();

vi.mock('wagmi', () => ({
  useAccount: () => accountMock(),
  useReadContract: () => readContractMock(),
  useSwitchChain: () => ({ switchChain: switchChainMock, isPending: false }),
  useConnect: () => ({
    connectors: [],
    connect: vi.fn(),
    isPending: false,
    error: null,
  }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useWriteContract: () => {
    const which = writeCallIdx % 2 === 0 ? 'merchant' : 'fee';
    writeCallIdx++;
    return writeMocks[which];
  },
  useWaitForTransactionReceipt: ({ hash }: { hash: Hex | undefined }) => {
    if (hash === undefined) {
      return { data: undefined, error: null, isSuccess: false, isError: false };
    }
    return (
      receiptMocks.byHash.get(hash) ?? {
        data: undefined,
        error: null,
        isSuccess: false,
        isError: false,
      }
    );
  },
}));

// gasless 系の hook は standard mode で enabled=false 呼出。crash 防止に空 stub。
vi.mock('@/hooks/useBatchPayment', () => ({
  useBatchPayment: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    data: undefined,
    error: null,
  }),
}));
vi.mock('@/hooks/useSmartAccount', () => ({
  useSmartAccount: () => ({ data: undefined, isLoading: false, error: null }),
}));
vi.mock('@/hooks/useGasQuoteUsdc', () => ({
  useGasQuoteUsdc: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useGasQuoteJpyc', () => ({
  useGasQuoteJpyc: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

import {
  useSearchParams,
  type ReadonlyURLSearchParams,
} from 'next/navigation';
import { PaymentForm } from '@/components/PaymentForm';

const MERCHANT: Address = '0x1111111111111111111111111111111111111111';
const CUSTOMER: Address = '0x9999999999999999999999999999999999999999';
const MERCHANT_TX: Hex = `0x${'a'.repeat(64)}`;
const FEE_TX: Hex = `0x${'b'.repeat(64)}`;

function setURL(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as unknown as ReadonlyURLSearchParams,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  writeCallIdx = 0;
  writeMocks.merchant.writeContract = vi.fn();
  writeMocks.merchant.reset = vi.fn();
  writeMocks.merchant.data = undefined;
  writeMocks.merchant.error = null;
  writeMocks.merchant.isPending = false;
  writeMocks.fee.writeContract = vi.fn();
  writeMocks.fee.reset = vi.fn();
  writeMocks.fee.data = undefined;
  writeMocks.fee.error = null;
  writeMocks.fee.isPending = false;
  receiptMocks.byHash.clear();
  accountMock.mockReturnValue({
    address: CUSTOMER,
    isConnected: true,
    chainId: baseSepolia.id,
    chain: baseSepolia,
  });
  readContractMock.mockReturnValue({
    data: 20_000_000n, // 20 USDC balance
    isLoading: false,
    error: null,
  });
});

describe('PaymentForm + real useStandardPayment (wagmi のみ mock)', () => {
  it('完全な happy path: mutate → merchant 確定 → fee 自動起動 → 全成功で SuccessOverlay', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    const { rerender } = render(<PaymentForm />);

    // 初期: 「10 USDC を支払う」 button が活性 (standard mode は SA 不要)
    const payBtn = screen.getByRole('button', { name: /10 USDC を支払う/ });
    expect(payBtn).not.toBeDisabled();

    // click → useStandardPayment.mutate → merchantWrite.writeContract 実呼出
    await user.click(payBtn);
    expect(writeMocks.merchant.writeContract).toHaveBeenCalledOnce();
    const merchantArgs = writeMocks.merchant.writeContract.mock.calls[0][0];
    // 0.5% fee → merchant = 9.95 USDC, fee = 0.05 USDC
    expect(merchantArgs.args).toEqual([MERCHANT, 9_950_000n]);
    expect(merchantArgs.functionName).toBe('transfer');

    // merchant tx broadcast (data set)
    act(() => {
      writeMocks.merchant.data = MERCHANT_TX;
      receiptMocks.byHash.set(MERCHANT_TX, {
        data: undefined,
        error: null,
        isSuccess: false,
        isError: false,
      });
    });
    rerender(<PaymentForm />);
    // phase: merchant-mining → button label 「店舗送金を確定中…」
    expect(
      screen.getByRole('button', { name: /店舗送金を確定中/ }),
    ).toBeDisabled();

    // merchant receipt 確定 (status=success) → useEffect が fee tx 自動起動
    act(() => {
      receiptMocks.byHash.set(MERCHANT_TX, {
        data: { status: 'success', blockNumber: 100n },
        error: null,
        isSuccess: true,
        isError: false,
      });
    });
    rerender(<PaymentForm />);
    await waitFor(() =>
      expect(writeMocks.fee.writeContract).toHaveBeenCalled(),
    );
    const feeArgs = writeMocks.fee.writeContract.mock.calls[0][0];
    expect(feeArgs.args).toEqual([
      // env.feeReceiver は test env で default ('0x...dEaD000...001234')
      expect.any(String),
      50_000n,
    ]);
    // phase: fee-sending
    expect(
      screen.getByRole('button', { name: /手数料の送金を承認してください/ }),
    ).toBeDisabled();

    // fee tx broadcast
    act(() => {
      writeMocks.fee.data = FEE_TX;
      receiptMocks.byHash.set(FEE_TX, {
        data: undefined,
        error: null,
        isSuccess: false,
        isError: false,
      });
    });
    rerender(<PaymentForm />);
    expect(
      screen.getByRole('button', { name: /手数料の送金を確定中/ }),
    ).toBeDisabled();

    // fee receipt 確定 → phase=success
    act(() => {
      receiptMocks.byHash.set(FEE_TX, {
        data: { status: 'success', blockNumber: 101n },
        error: null,
        isSuccess: true,
        isError: false,
      });
    });
    rerender(<PaymentForm />);

    await waitFor(() => {
      // SuccessOverlay の「決済完了」が出る
      expect(screen.getAllByText(/決済完了/).length).toBeGreaterThan(0);
    });
    // inline ResultPanel に merchant tx hash の full が出る
    expect(screen.getAllByText(MERCHANT_TX).length).toBeGreaterThanOrEqual(1);
    // fee tx hash も出る
    expect(screen.getAllByText(FEE_TX).length).toBeGreaterThanOrEqual(1);
  });

  it('fee tx wallet reject → fee-error UI + retry button click で fee writeContract 再呼出', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    const { rerender } = render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /10 USDC を支払う/ }));
    expect(writeMocks.merchant.writeContract).toHaveBeenCalledOnce();

    // merchant 確定 → fee 自動起動
    act(() => {
      writeMocks.merchant.data = MERCHANT_TX;
      receiptMocks.byHash.set(MERCHANT_TX, {
        data: { status: 'success', blockNumber: 100n },
        error: null,
        isSuccess: true,
        isError: false,
      });
    });
    rerender(<PaymentForm />);
    await waitFor(() =>
      expect(writeMocks.fee.writeContract).toHaveBeenCalledOnce(),
    );

    // fee tx wallet reject
    act(() => {
      writeMocks.fee.error = new Error('user rejected fee tx');
    });
    rerender(<PaymentForm />);

    // fee-error retry UI が出る
    await waitFor(() => {
      expect(
        screen.getByText(/OpenPay 利用手数料の送信に失敗/),
      ).toBeInTheDocument();
    });

    // retry click → fee writeContract が 2 回目の呼出
    const retryBtn = screen.getByRole('button', {
      name: /手数料の送信を再試行/,
    });
    // 退避: reset() が呼ばれた後の状態を simulate (本物の wagmi なら data/error clear)
    await user.click(retryBtn);
    expect(writeMocks.fee.reset).toHaveBeenCalled();
    expect(writeMocks.fee.writeContract).toHaveBeenCalledTimes(2);
    // 引数は最初と同じ (= fee 徴収 ERC20.transfer)
    const retryArgs = writeMocks.fee.writeContract.mock.calls[1][0];
    expect(retryArgs.functionName).toBe('transfer');
    expect(retryArgs.args[1]).toBe(50_000n);
  });

  it('merchant tx wallet reject → fee tx 不送信、エラーメッセージ表示', async () => {
    const user = userEvent.setup();
    setURL(`to=${MERCHANT}&token=usdc&amount=10&mode=standard`);
    const { rerender } = render(<PaymentForm />);

    await user.click(screen.getByRole('button', { name: /10 USDC を支払う/ }));
    expect(writeMocks.merchant.writeContract).toHaveBeenCalledOnce();

    act(() => {
      writeMocks.merchant.error = new Error('user rejected merchant tx');
    });
    rerender(<PaymentForm />);

    await waitFor(() => {
      expect(screen.getByText(/user rejected merchant tx/)).toBeInTheDocument();
    });
    // fee tx は不送信 (merchant 失敗で gate された)
    expect(writeMocks.fee.writeContract).not.toHaveBeenCalled();
    // fee-error retry UI は出ない
    expect(screen.queryByText(/OpenPay 利用手数料の送信に失敗/)).toBeNull();
  });
});
