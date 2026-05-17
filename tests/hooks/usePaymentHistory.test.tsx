import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { HISTORY_STORAGE_KEY, loadHistory } from '@/lib/history';

const CTX = {
  chainId: 80002,
  chainSlug: 'polygon' as const,
  asset: 'jpyc' as const,
  tokenAddress: '0xToken' as `0x${string}`,
  payMode: 'gasless' as const,
  gasMode: 'customer' as const,
  merchant: '0xMerchant' as `0x${string}`,
  merchantAmount: 1000n,
  customer: '0xCustomer' as `0x${string}`,
  feeReceiver: '0xFee' as `0x${string}`,
  feeAmount: 10n,
  storeName: '',
  note: '',
};

const NO_STANDARD = {
  data: undefined,
  phase: 'idle',
  merchantTxHash: undefined,
  feeTxHash: undefined,
  error: null,
};

const NO_GASLESS = { data: undefined, error: null };

describe('usePaymentHistory', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('gasless success → status=success の batch entry を append', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTx',
            userOpHash: '0xUO',
            blockNumber: 1n,
            success: true,
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].flow).toBe('batch');
    expect(loaded[0].status).toBe('success');
    expect(loaded[0].id).toBe('batch-0xTx');
  });

  it('gasless reverted (success=false) → status=reverted で記録', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTxR',
            userOpHash: '0xUOR',
            blockNumber: 2n,
            success: false,
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded[0].status).toBe('reverted');
  });

  it('gasless error → status=error の entry (txHash=null)', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        { data: undefined, error: new Error('paymaster rejected') },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].txHash).toBeNull();
    expect(loaded[0].errorMessage).toBe('paymaster rejected');
  });

  it('standard success (fee tx あり) → merchant + fee の 2 件が入る', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: {
          merchantTxHash: '0xMTx',
          feeTxHash: '0xFTx',
          blockNumber: 5n,
        },
        phase: 'success',
        merchantTxHash: '0xMTx',
        feeTxHash: '0xFTx',
        error: null,
      }),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => e.flow).sort()).toEqual([
      'standard-fee',
      'standard-merchant',
    ]);
  });

  it('standard success (fee tx なし、極小 fee=0) → merchant のみ 1 件', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: {
          merchantTxHash: '0xMTx2',
          feeTxHash: undefined,
          blockNumber: 6n,
        },
        phase: 'success',
        merchantTxHash: '0xMTx2',
        feeTxHash: undefined,
        error: null,
      }),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].flow).toBe('standard-merchant');
  });

  it('standard merchant-error → status=error の standard-merchant entry', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'merchant-error',
        merchantTxHash: '0xMTxRevert',
        feeTxHash: undefined,
        error: new Error('insufficient gas'),
      }),
    );
    const loaded = loadHistory();
    expect(loaded[0].flow).toBe('standard-merchant');
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].txHash).toBe('0xMTxRevert');
    expect(loaded[0].errorMessage).toBe('insufficient gas');
  });

  it('standard fee-error → status=error の standard-fee entry (merchant 着金済)', () => {
    renderHook(() =>
      usePaymentHistory(CTX, NO_GASLESS, {
        data: undefined,
        phase: 'fee-error',
        merchantTxHash: '0xMTxOk',
        feeTxHash: '0xFTxFail',
        error: new Error('fee tx reverted'),
      }),
    );
    const loaded = loadHistory();
    expect(loaded[0].flow).toBe('standard-fee');
    expect(loaded[0].status).toBe('error');
    expect(loaded[0].txHash).toBe('0xFTxFail');
  });

  it('error.message は 500 文字に truncate される (DoS 対策)', () => {
    const longMsg = 'X'.repeat(2000);
    renderHook(() =>
      usePaymentHistory(
        CTX,
        { data: undefined, error: new Error(longMsg) },
        NO_STANDARD,
      ),
    );
    const loaded = loadHistory();
    expect(loaded[0].errorMessage?.length).toBe(500);
  });

  it('hook が複数回 render しても同じ tx hash は重複しない (id dedupe)', () => {
    type GaslessData = {
      txHash: `0x${string}`;
      userOpHash: `0x${string}`;
      blockNumber: bigint;
      success: boolean;
    };
    const data: GaslessData = {
      txHash: '0xSame',
      userOpHash: '0xSameUO',
      blockNumber: 1n,
      success: true,
    };
    const { rerender } = renderHook(
      (gaslessData: GaslessData) =>
        usePaymentHistory(
          CTX,
          { data: gaslessData, error: null },
          NO_STANDARD,
        ),
      { initialProps: data },
    );
    rerender({ ...data });
    expect(loadHistory()).toHaveLength(1);
  });

  it('LocalStorage に直接 entry が出る (key=openpay:history:v1)', () => {
    renderHook(() =>
      usePaymentHistory(
        CTX,
        {
          data: {
            txHash: '0xTxLs',
            userOpHash: '0xUOLs',
            blockNumber: 1n,
            success: true,
          },
          error: null,
        },
        NO_STANDARD,
      ),
    );
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).toContain('0xTxLs');
  });
});
