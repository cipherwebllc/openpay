'use client';

// LocalStorage 上の PayerReceipt[] (顧客向け電子レシート) を React state として購読する。
// useHistory と同型: 'storage' event (別タブ) + CustomEvent (自タブの append) の二経路で再 load。

import { useEffect, useRef, useState } from 'react';
import {
  loadPayerReceipts,
  PAYER_RECEIPTS_CHANGED_EVENT,
  PAYER_RECEIPTS_STORAGE_KEY,
  type PayerReceipt,
} from '@/lib/payerReceipt';
import {
  fetchReceiptTxStatus,
  isReconcilableReceipt,
  RECONCILE_BATCH_MAX,
  reconcilePendingReceipts,
} from '@/lib/payerReceiptReconcile';

// 同一セッションの on-chain 照合の状態。このフックは PayerReceiptList / PayerReceiptCompletion /
// HistoryView 等の複数箇所でマウントされ、昇格→reload→effect 再発火もあるため module-level に持つ
// (昇格はストア書込→broadcast→CHANGED_EVENT で各 listener が reload するので state を直接いじらない)。
//   - settled: 成立 / 失敗を確かめた控え。二度と照会しない。
//   - inFlight: いま照会している控え (複数のマウントから同じ控えへ重ねて RPC しない)。
//   - retry: 未確定 (receipt 未発見・RPC 失敗) だった控えの照会回数と次に照会してよい時刻。
// 照会しなかった控え (1 回の上限 10 件を超えた分) はどれにも入れず、次の回に回す (第 7 回レビュー A10)。
const settledReceiptIds = new Set<string>();
const inFlightReceiptIds = new Set<string>();
const retryReceipts = new Map<string, { attempts: number; dueAt: number }>();

// 未確定の控えを再照会するまでの間隔 (回数ごとに倍・上限 5 分)。画面を開いている間の RPC を抑える。
const RECHECK_BASE_MS = 15_000;
const RECHECK_MAX_MS = 5 * 60_000;

function recheckDelay(attempts: number): number {
  return Math.min(RECHECK_BASE_MS * 2 ** (attempts - 1), RECHECK_MAX_MS);
}

export function usePayerReceipts(): {
  receipts: PayerReceipt[];
  /** ハイドレート完了後の true (SSR 初回描画と client mount の差分を吸収)。 */
  hydrated: boolean;
} {
  const [receipts, setReceipts] = useState<PayerReceipt[]>(() => loadPayerReceipts());
  const [hydrated, setHydrated] = useState(false);
  // 照合の 1 回が終わった・再照会の時刻が来たときに、下の照合 effect をもう一度回すための合図。
  const [reconcileRound, setReconcileRound] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setReceipts(loadPayerReceipts());
    setHydrated(true);

    const reload = () => setReceipts(loadPayerReceipts());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === PAYER_RECEIPTS_STORAGE_KEY) reload();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(PAYER_RECEIPTS_CHANGED_EVENT, reload);
    return () => {
      mountedRef.current = false;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(PAYER_RECEIPTS_CHANGED_EVENT, reload);
    };
  }, []);

  // hydrate 後に pending 控えを on-chain receipt で照合し、確定済みを昇格する。1 回に照会するのは
  // 新しい順に 10 件まで。照会した控えだけを結果で振り分け (成立 / 失敗 → settled・未確定 → 間隔を
  // 空けて再照会)、残りは次の回に回す。receipts を依存に含めるのは新規 pending も対象にするため。
  useEffect(() => {
    if (!hydrated) return;
    const now = Date.now();
    const waiting = receipts.filter(
      (r) =>
        isReconcilableReceipt(r) &&
        !settledReceiptIds.has(r.receiptId) &&
        !inFlightReceiptIds.has(r.receiptId),
    );
    const due = waiting.filter((r) => (retryReceipts.get(r.receiptId)?.dueAt ?? 0) <= now);
    if (due.length > 0) {
      const batch = due.slice(0, RECONCILE_BATCH_MAX);
      for (const r of batch) inFlightReceiptIds.add(r.receiptId);
      void reconcilePendingReceipts(batch, fetchReceiptTxStatus, { max: batch.length }).then(
        (results) => {
          const statusById = new Map(results.map((x) => [x.receiptId, x.status]));
          for (const r of batch) {
            inFlightReceiptIds.delete(r.receiptId);
            const status = statusById.get(r.receiptId);
            if (status === 'success' || status === 'reverted') {
              retryReceipts.delete(r.receiptId);
              settledReceiptIds.add(r.receiptId);
            } else {
              const attempts = (retryReceipts.get(r.receiptId)?.attempts ?? 0) + 1;
              retryReceipts.set(r.receiptId, { attempts, dueAt: Date.now() + recheckDelay(attempts) });
            }
          }
          // 照会しなかった残り・再照会の予定を、この画面のまま続けて回す (外したマウントは回さない)。
          if (mountedRef.current) setReconcileRound((n) => n + 1);
        },
      );
      return;
    }
    // いま照会できる控えが無ければ、いちばん早い再照会の時刻にもう一度回す。
    const nextDueAt = Math.min(
      ...waiting.map((r) => retryReceipts.get(r.receiptId)?.dueAt ?? Infinity),
    );
    if (!Number.isFinite(nextDueAt)) return;
    const timer = setTimeout(() => setReconcileRound((n) => n + 1), Math.max(0, nextDueAt - now));
    return () => clearTimeout(timer);
  }, [hydrated, receipts, reconcileRound]);

  return { receipts, hydrated };
}
