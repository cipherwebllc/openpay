import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reconcilePendingReceipts,
  type ReceiptTxStatus,
} from '@/lib/payerReceiptReconcile';
import {
  appendPayerReceipt,
  buildPayerReceipt,
  loadPayerReceipts,
  type PayerReceipt,
} from '@/lib/payerReceipt';

const NOW = new Date('2026-06-04T01:42:00.000Z');
const CHAIN = 80002; // polygonAmoy

/** pending 控えを 1 件作る (store には入れない・配列で reconcile に渡す)。 */
function pending(over: Partial<PayerReceipt> = {}): PayerReceipt {
  const base = buildPayerReceipt(
    { asset: 'jpyc', amount: '1', merchantAddress: '0xM', txHash: '0xtx', chainId: CHAIN },
    NOW,
  );
  return { ...base, status: 'pending', paidAt: undefined, ...over };
}

/** reconcile が store 上の entry を昇格できるよう、ストアに pending を仕込む。 */
function seed(r: PayerReceipt) {
  appendPayerReceipt(r);
  // store に入れた直後は pending のまま (回帰防止)。
  expect(loadPayerReceipts().find((x) => x.receiptId === r.receiptId)?.status).toBe('pending');
}

function statusOf(receiptId: string): string | undefined {
  return loadPayerReceipts().find((r) => r.receiptId === receiptId)?.status;
}

describe('reconcilePendingReceipts', () => {
  beforeEach(() => window.localStorage.clear());

  it("success → store 上で confirmed に昇格・戻り値 1", async () => {
    const r = pending({ receiptId: '0xs1', txHash: '0xs1' });
    seed(r);
    const fetchStatus = vi.fn(async (): Promise<ReceiptTxStatus> => 'success');
    const n = await reconcilePendingReceipts([r], fetchStatus);
    expect(n).toBe(1);
    expect(fetchStatus).toHaveBeenCalledWith(CHAIN, '0xs1');
    expect(statusOf('0xs1')).toBe('confirmed');
  });

  it('reverted → failed に昇格', async () => {
    const r = pending({ receiptId: '0xr1', txHash: '0xr1' });
    seed(r);
    const fetchStatus = vi.fn(async (): Promise<ReceiptTxStatus> => 'reverted');
    const n = await reconcilePendingReceipts([r], fetchStatus);
    expect(n).toBe(1);
    expect(statusOf('0xr1')).toBe('failed');
  });

  it('unknown → pending のまま・戻り値 0', async () => {
    const r = pending({ receiptId: '0xu1', txHash: '0xu1' });
    seed(r);
    const fetchStatus = vi.fn(async (): Promise<ReceiptTxStatus> => 'unknown');
    const n = await reconcilePendingReceipts([r], fetchStatus);
    expect(n).toBe(0);
    expect(statusOf('0xu1')).toBe('pending');
  });

  it('txHash 無し / chainId 無し / status non-pending は fetcher が呼ばれない', async () => {
    const noTx = pending({ receiptId: '0xn1', txHash: undefined });
    const noChain = pending({ receiptId: '0xn2', txHash: '0xn2', chainId: undefined });
    const confirmed = pending({ receiptId: '0xn3', txHash: '0xn3', status: 'confirmed' });
    const fetchStatus = vi.fn(async (): Promise<ReceiptTxStatus> => 'success');
    const n = await reconcilePendingReceipts([noTx, noChain, confirmed], fetchStatus);
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it('max 超過分は照合されない (fetcher 呼び出し回数で assert)', async () => {
    const receipts = Array.from({ length: 5 }, (_, i) =>
      pending({ receiptId: `0xm${i}`, txHash: `0xm${i}` }),
    );
    const fetchStatus = vi.fn(async (): Promise<ReceiptTxStatus> => 'unknown');
    await reconcilePendingReceipts(receipts, fetchStatus, { max: 2 });
    // 新しい順 (配列順) に先頭 2 件のみ照合。
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(fetchStatus).toHaveBeenNthCalledWith(1, CHAIN, '0xm0');
    expect(fetchStatus).toHaveBeenNthCalledWith(2, CHAIN, '0xm1');
  });

  it('対象が 0 件なら fetcher を呼ばず 0 を返す', async () => {
    const fetchStatus = vi.fn(async (): Promise<ReceiptTxStatus> => 'success');
    const n = await reconcilePendingReceipts([], fetchStatus);
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });
});
