'use client';

// LocalStorage 上の PayerReceipt[] (顧客向け電子レシート) を React state として購読する。
// useHistory と同型: 'storage' event (別タブ) + CustomEvent (自タブの append) の二経路で再 load。

import { useEffect, useState } from 'react';
import {
  loadPayerReceipts,
  PAYER_RECEIPTS_CHANGED_EVENT,
  PAYER_RECEIPTS_STORAGE_KEY,
  type PayerReceipt,
} from '@/lib/payerReceipt';
import {
  fetchReceiptTxStatus,
  reconcilePendingReceipts,
} from '@/lib/payerReceiptReconcile';

// 同一セッション内で既に on-chain 照合した receiptId。このフックは PayerReceiptList /
// PayerReceiptCompletion / HistoryView の複数箇所でマウントされ、昇格→reload→effect 再発火
// もあり得るため、module-level に保持して重複 RPC を抑止する (昇格はストア書込→broadcast→
// CHANGED_EVENT で各 listener が reload するので state を直接いじらない)。
const reconciledReceiptIds = new Set<string>();

export function usePayerReceipts(): {
  receipts: PayerReceipt[];
  /** ハイドレート完了後の true (SSR 初回描画と client mount の差分を吸収)。 */
  hydrated: boolean;
} {
  const [receipts, setReceipts] = useState<PayerReceipt[]>(() => loadPayerReceipts());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setReceipts(loadPayerReceipts());
    setHydrated(true);

    const reload = () => setReceipts(loadPayerReceipts());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === PAYER_RECEIPTS_STORAGE_KEY) reload();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(PAYER_RECEIPTS_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(PAYER_RECEIPTS_CHANGED_EVENT, reload);
    };
  }, []);

  // hydrate 後に pending 控えを on-chain receipt で照合し、確定済みを昇格する。
  // 既に照合した receiptId は module-level Set で除外し重複 RPC を防ぐ (複数箇所マウント・
  // 昇格→reload→effect 再発火でも RPC を再発させない)。昇格は store 書込→broadcast→
  // 上の CHANGED_EVENT listener が reload するため、ここで state は触らない。receipts を
  // 依存に含めるのは新規 pending が増えた場合も対象にするためで、Set ガードで安全。
  useEffect(() => {
    if (!hydrated) return;
    const unchecked = receipts.filter((r) => !reconciledReceiptIds.has(r.receiptId));
    if (unchecked.length === 0) return;
    for (const r of unchecked) reconciledReceiptIds.add(r.receiptId);
    void reconcilePendingReceipts(unchecked, fetchReceiptTxStatus);
  }, [hydrated, receipts]);

  return { receipts, hydrated };
}
