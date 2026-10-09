import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePayerReceipts } from '@/hooks/usePayerReceipts';
import {
  buildPayerReceipt,
  loadPayerReceipts,
  PAYER_RECEIPTS_STORAGE_KEY,
  type PayerReceipt,
} from '@/lib/payerReceipt';
import { fetchReceiptTxStatus, type ReceiptTxStatus } from '@/lib/payerReceiptReconcile';

// 第 7 回レビュー A10: 照合していない控えを照合済みに固定しない。照合 (reconcilePendingReceipts) は実物で、
// on-chain の照会 (fetchReceiptTxStatus) だけを差し替える。照合の状態はモジュールで持つので、テストごとに
// 別の txHash を使う。
vi.mock('@/lib/payerReceiptReconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payerReceiptReconcile')>()),
  fetchReceiptTxStatus: vi.fn(),
}));

const fetchMock = vi.mocked(fetchReceiptTxStatus);
const NOW = new Date('2026-10-09T01:00:00.000Z');
const CHAIN = 80002;

function pending(txHash: string): PayerReceipt {
  return {
    ...buildPayerReceipt({ asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash, chainId: CHAIN }, NOW),
    status: 'pending',
    paidAt: undefined,
  };
}

function seed(receipts: PayerReceipt[]) {
  window.localStorage.setItem(PAYER_RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
}

const statusOf = (txHash: string) => loadPayerReceipts().find((r) => r.txHash === txHash)?.status;
const queried = (txHash: string) => fetchMock.mock.calls.filter(([, h]) => h === txHash).length;

describe('usePayerReceipts: 照合の順送りと再照会 (A10)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pending が 11 件: 一度に照会するのは 10 件まで・11 件目も同じ画面で続けて照会して確定する', async () => {
    // 新しい 10 件は未着 (unknown)・11 件目 (いちばん古い) は成立済み。
    const receipts = Array.from({ length: 11 }, (_, i) => pending(`0xa10-batch-${i}`));
    seed(receipts);
    fetchMock.mockImplementation(async (_c, h): Promise<ReceiptTxStatus> =>
      h === '0xa10-batch-10' ? 'success' : 'unknown',
    );
    renderHook(() => usePayerReceipts());
    await waitFor(() => expect(statusOf('0xa10-batch-10')).toBe('confirmed'));
    // 1 回目の 10 件は 1 回ずつ (すぐには再照会しない)。
    for (let i = 0; i < 10; i++) expect(queried(`0xa10-batch-${i}`)).toBe(1);
    expect(queried('0xa10-batch-10')).toBe(1);
  });

  it('未着 (unknown) だった控えは間隔を空けて再照会し、成立したら確定する', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seed([pending('0xa10-retry')]);
    fetchMock.mockResolvedValueOnce('unknown').mockResolvedValue('success');
    renderHook(() => usePayerReceipts());
    await waitFor(() => expect(queried('0xa10-retry')).toBe(1));
    expect(statusOf('0xa10-retry')).toBe('pending');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => expect(statusOf('0xa10-retry')).toBe('confirmed'));
    expect(queried('0xa10-retry')).toBe(2);
  });

  it('確定 (成立 / 失敗) を確かめた控えは、マウントし直しても照会しない', async () => {
    seed([pending('0xa10-done')]);
    fetchMock.mockResolvedValue('reverted');
    const first = renderHook(() => usePayerReceipts());
    await waitFor(() => expect(statusOf('0xa10-done')).toBe('failed'));
    first.unmount();
    // ストアの控えを pending に戻しても (別タブの古い書き込み等)、このセッションでは確定済みとして扱う。
    seed([pending('0xa10-done')]);
    renderHook(() => usePayerReceipts());
    await act(async () => {
      await Promise.resolve();
    });
    expect(queried('0xa10-done')).toBe(1);
  });

  it('同時にマウントした 2 か所から同じ控えを重ねて照会しない', async () => {
    seed([pending('0xa10-dup')]);
    fetchMock.mockResolvedValue('success');
    renderHook(() => {
      usePayerReceipts();
      return usePayerReceipts();
    });
    await waitFor(() => expect(statusOf('0xa10-dup')).toBe('confirmed'));
    expect(queried('0xa10-dup')).toBe(1);
  });
});
