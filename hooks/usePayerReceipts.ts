'use client';

// LocalStorage 上の PayerReceipt[] (顧客向け電子レシート) を React state として購読する。
// useHistory と同型: 'storage' event (別タブ) + CustomEvent (自タブの append) の二経路で再 load。

import { useEffect, useState } from 'react';
import {
  loadPayerReceipts,
  PAYER_RECEIPTS_CHANGED_EVENT,
  PAYER_RECEIPTS_STORAGE_KEY,
  promotePayerReceiptStatus,
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
//   - 成立 / 失敗を確かめた控えは、その結果と tx hash を覚えて RPC を二度と出さない。ストアへの保存は確かめ、
//     保存できなかったら (書き込みの失敗・読み込みの一時失敗) 間隔を空けて保存だけやり直す。保存した後でも、
//     一覧に pending で戻ってきたら (別タブの古い書き込み等) 覚えている結果で保存し直す。
//   - 未確定 (receipt 未発見・RPC 失敗) は間隔を空けて再照会し、上限の回数で止める (未確定のまま。次にページを
//     開いたとき最初から)。
// 昇格はストア書込→broadcast→CHANGED_EVENT で各画面が reload するので、ここから React の state は触らない。
// 照合する控えの一覧は画面が読み込んだもの (いちばん新しいもの) を受け取る (照会のたびに localStorage を読み直して、
// 壊れた保存値の警告を増やさない)。

// 再照会・保存のやり直しの間隔 (回数ごとに倍・上限 5 分) と回数の上限。15 秒から倍々で 8 回 (15 秒・30 秒・1 分・
// 2 分・4 分・5 分 ×3) = 初回から約 23 分。relay / gasless の確認待ちはふつう数分で確定するので、混雑や RPC の一時
// 障害を越えて待つには足り、それより長く未確定なら tx が落ちた・RPC が止まっている見込みが高い。上限で止めて、
// 開いたままのタブが照会を出し続けないようにする (未確定の控えが上限の 200 件あっても、1 ページで 200 × 9 回まで)。
const RECHECK_BASE_MS = 15_000;
const RECHECK_MAX_MS = 5 * 60_000;
const MAX_RECHECKS = 8;

// on-chain で確かめた結果 (成立 → confirmed・失敗 → failed) と、その tx hash。saveAttempts / saveDueAt は
// ストアへの保存をやり直した回数と、次にやり直してよい時刻 (保存できたら 0・上限を超えたら Infinity)。
type ResolvedReceipt = {
  status: 'confirmed' | 'failed';
  txHash: string;
  saveAttempts: number;
  saveDueAt: number;
};

const reconcileState = {
  subscribers: 0,
  resolved: new Map<string, ResolvedReceipt>(),
  inFlight: new Set<string>(),
  // 未確定だった回数と、次に照会してよい時刻 (上限を超えたら Infinity = このページでは照会しない)。
  retry: new Map<string, { attempts: number; dueAt: number }>(),
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  receipts: [] as PayerReceipt[],
};

function recheckDelay(attempts: number): number {
  return Math.min(RECHECK_BASE_MS * 2 ** (attempts - 1), RECHECK_MAX_MS);
}

function nextAttemptAt(attempts: number, now: number): number {
  return attempts > MAX_RECHECKS ? Infinity : now + recheckDelay(attempts);
}

function clearReconcileTimer(): void {
  if (reconcileState.timer === undefined) return;
  clearTimeout(reconcileState.timer);
  reconcileState.timer = undefined;
}

// ストアの控えが既にこの結果で保存されているか (昇格が false を返す「既に確定」と「保存できなかった」を分ける)。
function storedAs(id: string, status: ResolvedReceipt['status']): boolean {
  return loadPayerReceipts().some((r) => r.receiptId === id && r.status === status);
}

// 確かめた結果をストアへ保存する (RPC は出さない)。保存できた・既に確定で保存されている → やり直しは要らない。
// それ以外 (書き込みの失敗・読み込みの一時失敗) は間隔を空けてやり直す。
function saveResolved(id: string, known: ResolvedReceipt, now: number): void {
  if (promotePayerReceiptStatus(id, known.status) || storedAs(id, known.status)) {
    known.saveAttempts = 0;
    known.saveDueAt = 0;
    return;
  }
  known.saveAttempts += 1;
  known.saveDueAt = nextAttemptAt(known.saveAttempts, now);
}

// 照会できる控えを空いている枠の分だけ照会し、結果を確かめ済みで pending のままの控えは保存し直し、まだ時刻の
// 来ない再照会・保存のやり直しはいちばん早い時刻にもう一度回す。
function pumpReconcile(): void {
  if (reconcileState.subscribers === 0) return;
  clearReconcileTimer();
  const now = Date.now();
  let slots = RECONCILE_BATCH_MAX - reconcileState.inFlight.size;
  let nextDueAt = Infinity;
  for (const r of reconcileState.receipts) {
    const id = r.receiptId;
    if (!isReconcilableReceipt(r) || reconcileState.inFlight.has(id)) continue;
    const known = reconcileState.resolved.get(id);
    if (known && known.txHash === r.txHash) {
      if (known.saveDueAt <= now) saveResolved(id, known, now);
      if (known.saveDueAt > now) nextDueAt = Math.min(nextDueAt, known.saveDueAt);
      continue;
    }
    if (known) {
      // 控えの tx hash が変わった (Gateway の reorg 後の付け替え等) → 覚えた結果は別の tx のもの。照会し直す。
      reconcileState.resolved.delete(id);
      reconcileState.retry.delete(id);
    }
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
  const txHash = r.txHash as string;
  reconcileState.inFlight.add(id);
  void reconcilePendingReceipts([r], fetchReceiptTxStatus, { max: 1 }).then((results) => {
    reconcileState.inFlight.delete(id);
    const result = results.find((x) => x.receiptId === id);
    const now = Date.now();
    if (result && (result.status === 'success' || result.status === 'reverted')) {
      reconcileState.retry.delete(id);
      const known: ResolvedReceipt = {
        status: result.status === 'success' ? 'confirmed' : 'failed',
        txHash,
        saveAttempts: 0,
        saveDueAt: 0,
      };
      // 照合の中で保存できていなければ (書き込み・読み込みの失敗)、保存だけを間隔を空けてやり直す。
      if (!result.promoted && !storedAs(id, known.status)) {
        known.saveAttempts = 1;
        known.saveDueAt = nextAttemptAt(1, now);
      }
      reconcileState.resolved.set(id, known);
    } else {
      const attempts = (reconcileState.retry.get(id)?.attempts ?? 0) + 1;
      reconcileState.retry.set(id, { attempts, dueAt: nextAttemptAt(attempts, now) });
    }
    // 空いた枠と再照会の予定を、残っている画面に引き継ぐ (画面が 0 なら何もしない)。
    pumpReconcile();
  });
}

// 画面が読み込んだ控えの一覧で照合を回し直す (控えが増えた・変わったとき・購読を始めたとき)。
function updateReconcileReceipts(receipts: PayerReceipt[]): void {
  reconcileState.receipts = receipts;
  pumpReconcile();
}

// 購読だけを数える。照会は最新の一覧を受け取ってから始める (画面が 0 の間に古くなった一覧で枠を埋めない)。
function subscribeReconcile(): () => void {
  reconcileState.subscribers += 1;
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
