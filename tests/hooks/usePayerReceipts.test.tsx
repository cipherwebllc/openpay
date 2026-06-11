import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePayerReceipts } from '@/hooks/usePayerReceipts';
import {
  appendPayerReceipt,
  buildPayerReceipt,
  PAYER_RECEIPTS_STORAGE_KEY,
  type PayerReceipt,
} from '@/lib/payerReceipt';
import { reconcilePendingReceipts } from '@/lib/payerReceiptReconcile';

// hydrate 後の on-chain 照合を no-op に差し替え (jsdom に実 RPC 無し)。spy で呼出を検証。
vi.mock('@/lib/payerReceiptReconcile', () => ({
  reconcilePendingReceipts: vi.fn(async () => 0),
  fetchReceiptTxStatus: vi.fn(async () => 'unknown' as const),
}));

const reconcileMock = vi.mocked(reconcilePendingReceipts);

const NOW = new Date('2026-06-04T01:42:00.000Z');

function receipt(txHash: string): PayerReceipt {
  return buildPayerReceipt(
    { asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash },
    NOW,
  );
}

function pendingReceipt(txHash: string): PayerReceipt {
  return { ...receipt(txHash), status: 'pending', paidAt: undefined };
}

/** CHANGED_EVENT を介さず LocalStorage を直接書く (cross-tab storage event / reconcile seed 用)。 */
function writeRaw(receipts: PayerReceipt[]) {
  window.localStorage.setItem(PAYER_RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
}

describe('usePayerReceipts', () => {
  beforeEach(() => window.localStorage.clear());

  it('初期: 空ストアなら [] + マウント後 hydrated=true', () => {
    const { result } = renderHook(() => usePayerReceipts());
    expect(result.current.receipts).toEqual([]);
    expect(result.current.hydrated).toBe(true);
  });

  it('初期: 既存 LocalStorage を load', () => {
    writeRaw([receipt('0xpre')]);
    const { result } = renderHook(() => usePayerReceipts());
    expect(result.current.receipts.map((r) => r.txHash)).toEqual(['0xpre']);
  });

  it('同タブ append (CHANGED_EVENT) → 再 load して反映', () => {
    const { result } = renderHook(() => usePayerReceipts());
    expect(result.current.receipts).toHaveLength(0);
    act(() => {
      appendPayerReceipt(receipt('0xnew'));
    });
    expect(result.current.receipts.map((r) => r.txHash)).toEqual(['0xnew']);
  });

  it('別タブ storage event (key 一致) → 再 load', () => {
    const { result } = renderHook(() => usePayerReceipts());
    writeRaw([receipt('0xcrosstab')]); // 直接書込 (CustomEvent は飛ばない)
    expect(result.current.receipts).toHaveLength(0); // まだ反映されない
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: PAYER_RECEIPTS_STORAGE_KEY }),
      );
    });
    expect(result.current.receipts.map((r) => r.txHash)).toEqual(['0xcrosstab']);
  });

  it('storage event (key 不一致) → 無視 (再 load しない)', () => {
    const { result } = renderHook(() => usePayerReceipts());
    writeRaw([receipt('0xother')]);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'openpay:history:v1' }));
    });
    expect(result.current.receipts).toHaveLength(0); // 別 key なので無反応
  });

  it('storage event (key=null = clear) → 再 load', () => {
    writeRaw([receipt('0xa')]);
    const { result } = renderHook(() => usePayerReceipts());
    expect(result.current.receipts).toHaveLength(1);
    window.localStorage.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(result.current.receipts).toHaveLength(0);
  });

  it('unmount 後はリスナ解除 (CHANGED_EVENT で state 更新しない)', () => {
    const { result, unmount } = renderHook(() => usePayerReceipts());
    unmount();
    // unmount 後の append は購読解除済みで反映されない (throw しない)。
    act(() => {
      appendPayerReceipt(receipt('0xafter'));
    });
    expect(result.current.receipts).toHaveLength(0);
  });
});

describe('usePayerReceipts: hydrate 後の pending 照合 (reconcile)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    reconcileMock.mockClear();
  });

  it('hydrate 後に reconcilePendingReceipts を一度発火 (未照合の控えを渡す)', () => {
    // module-level Set との衝突を避けるためテスト固有の txHash を使う。
    writeRaw([pendingReceipt('0xrec-A')]);
    renderHook(() => usePayerReceipts());
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const passed = reconcileMock.mock.calls[0][0] as PayerReceipt[];
    expect(passed.map((r) => r.txHash)).toContain('0xrec-A');
  });

  it('同一 receipt で再マウントしても fetcher (reconcile) は再発しない (module Set ガード)', () => {
    writeRaw([pendingReceipt('0xrec-B')]);
    const first = renderHook(() => usePayerReceipts());
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    first.unmount();
    reconcileMock.mockClear();
    // 同一 receiptId は照合済み Set に入っているため、再マウントで unchecked=0 → 再発火しない。
    renderHook(() => usePayerReceipts());
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
