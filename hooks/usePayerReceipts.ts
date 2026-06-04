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

  return { receipts, hydrated };
}
