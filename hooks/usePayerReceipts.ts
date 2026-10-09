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
  isReconcilableReceipt,
  RECONCILE_BATCH_MAX,
  reconcilePendingReceipts,
} from '@/lib/payerReceiptReconcile';

// --- 控えの on-chain 照合の調整役 (モジュールに 1 つ・第 7 回レビュー A10) ------------------------------
// このフックは PayerReceiptList / PayerReceiptCompletion / HistoryView 等の複数箇所でマウントされる。照合の
// 状態と照会の予定はマウントごとではなく、ここで 1 つにまとめて持つ。
//   - 同時に照会するのは全体で RECONCILE_BATCH_MAX (10) 件まで (照会中の件数を含めて数える)。
//   - 1 件の照会が終わるたびに枠を空け、まだ画面 (購読) が 1 つでも残っていれば次の照会と再照会の予定を
//     引き継ぐ (照会を始めた画面が先に外れても止まらない)。画面が 0 になったら次の照会は始めず、予定も消す。
//   - 成立 / 失敗を確かめた控えは settled (このページでは二度と照会しない)。未確定 (receipt 未発見・RPC 失敗) は
//     間隔を空けて再照会し、上限の回数で止める (未確定のまま。次にページを開いたとき最初から)。
// 昇格はストア書込→broadcast→CHANGED_EVENT で各画面が reload するので、ここから React の state は触らない。
// 照合する控えの一覧は画面が読み込んだもの (いちばん新しいもの) を受け取る (照会のたびに localStorage を読み直して、
// 壊れた保存値の警告を増やさない)。

// 再照会の間隔 (回数ごとに倍・上限 5 分) と回数の上限。15 秒から倍々で 8 回 (15 秒・30 秒・1 分・2 分・4 分・5 分 ×3)
// = 初回から約 23 分。relay / gasless の確認待ちはふつう数分で確定するので、混雑や RPC の一時障害を越えて待つには
// 足り、それより長く未確定なら tx が落ちた・RPC が止まっている見込みが高い。上限で止めて、開いたままのタブが
// 照会を出し続けないようにする (未確定の控えが上限の 200 件あっても、1 ページで 200 × 9 回まで)。
const RECHECK_BASE_MS = 15_000;
const RECHECK_MAX_MS = 5 * 60_000;
const MAX_RECHECKS = 8;

const reconcileState = {
  subscribers: 0,
  settled: new Set<string>(),
  inFlight: new Set<string>(),
  // 未確定だった回数と、次に照会してよい時刻 (上限を超えたら Infinity = このページでは照会しない)。
  retry: new Map<string, { attempts: number; dueAt: number }>(),
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  receipts: [] as PayerReceipt[],
};

function recheckDelay(attempts: number): number {
  return Math.min(RECHECK_BASE_MS * 2 ** (attempts - 1), RECHECK_MAX_MS);
}

function clearReconcileTimer(): void {
  if (reconcileState.timer === undefined) return;
  clearTimeout(reconcileState.timer);
  reconcileState.timer = undefined;
}

// 照会できる控えを空いている枠の分だけ照会し、まだ時刻の来ない再照会はいちばん早い時刻にもう一度回す。
function pumpReconcile(): void {
  if (reconcileState.subscribers === 0) return;
  clearReconcileTimer();
  const now = Date.now();
  let slots = RECONCILE_BATCH_MAX - reconcileState.inFlight.size;
  let nextDueAt = Infinity;
  for (const r of reconcileState.receipts) {
    const id = r.receiptId;
    if (!isReconcilableReceipt(r) || reconcileState.settled.has(id) || reconcileState.inFlight.has(id)) continue;
    const dueAt = reconcileState.retry.get(id)?.dueAt ?? 0;
    if (dueAt > now) {
      nextDueAt = Math.min(nextDueAt, dueAt);
      continue;
    }
    // 枠が埋まっている分は、照会が 1 件終わったとき (枠が空いたとき) に回す。
    if (slots <= 0) continue;
    slots -= 1;
    startReconcile(r);
  }
  if (Number.isFinite(nextDueAt)) {
    reconcileState.timer = setTimeout(pumpReconcile, nextDueAt - now);
  }
}

function startReconcile(r: PayerReceipt): void {
  const id = r.receiptId;
  reconcileState.inFlight.add(id);
  void reconcilePendingReceipts([r], fetchReceiptTxStatus, { max: 1 }).then((results) => {
    reconcileState.inFlight.delete(id);
    const status = results.find((x) => x.receiptId === id)?.status;
    if (status === 'success' || status === 'reverted') {
      reconcileState.retry.delete(id);
      reconcileState.settled.add(id);
    } else {
      const attempts = (reconcileState.retry.get(id)?.attempts ?? 0) + 1;
      reconcileState.retry.set(id, {
        attempts,
        dueAt: attempts > MAX_RECHECKS ? Infinity : Date.now() + recheckDelay(attempts),
      });
    }
    // 空いた枠と再照会の予定を、残っている画面に引き継ぐ (画面が 0 なら何もしない)。
    pumpReconcile();
  });
}

// 画面が読み込んだ控えの一覧で照合を回し直す (控えが増えた・変わったとき)。
function updateReconcileReceipts(receipts: PayerReceipt[]): void {
  reconcileState.receipts = receipts;
  pumpReconcile();
}

function subscribeReconcile(): () => void {
  reconcileState.subscribers += 1;
  pumpReconcile();
  return () => {
    reconcileState.subscribers -= 1;
    if (reconcileState.subscribers === 0) clearReconcileTimer();
  };
}

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

  // hydrate 後は照合の調整役を購読する (この画面がある間、pending 控えの照合と再照会が続く)。
  useEffect(() => {
    if (!hydrated) return;
    return subscribeReconcile();
  }, [hydrated]);

  // 控えが増えた・変わった (同じタブの append・別タブの書込) ら照合を回し直す。同時に照会する件数は調整役が
  // 全体で数えるので、保存通知のたびに照会が重なることはない。
  useEffect(() => {
    if (hydrated) updateReconcileReceipts(receipts);
  }, [hydrated, receipts]);

  return { receipts, hydrated };
}
