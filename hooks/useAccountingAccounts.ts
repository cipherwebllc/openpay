'use client';

// 会計仕訳 CSV の勘定科目 (店が変えた名前) を、この端末の localStorage に残す。
// 保存の形は { debit, credit } で、空文字 = 既定の科目 (lib/accountingAccounts.ts)。
// - 読むのは mount のときと、このタブが前面に戻ったとき (focus・visibilitychange で visible)。mount では書かない
//   (履歴ページを開くだけで保存の key を作らない)。hydrate の前は既定の科目。
// - 書くのは setAccount のときだけで、その場で (同期で) 書く。最新の保存値を読み直し、変えた項目だけを置き換える
//   (古い state の全体を書くと、別のタブが変えたもう片方の項目を消す・戻すため)。読み直しと書き込みは 1 つの同期の
//   処理で、タブをまたぐロックは取らない: 2 つのタブが同じ瞬間 (この処理の途中) に別々の項目を確定したときだけ、
//   先に書いた方の項目が消え得る (残る限界。人の操作では起きない間隔)。
// - storage を読めない (getItem が throw) ときは、取り込まず、書きもしない: 今の名前を保ち、その間に変えた項目は
//   この画面の間だけ使う (保存しない・後から書かない)。読めないまま古い state の全体を書いたり、後からまとめて
//   書いたりすると、別のタブが変えた項目を戻す・上書きするため。読めるようになって前面に戻ると、保存値に合わせる。
// - 保存の key が無い・保存値が JSON でないときは、守る保存値が無いので、今の名前を土台に書く。取り込みはしない
//   (見えている名前を既定の科目に戻さない)。
// 共通の useLocalStorageSettings は使わない (履歴ページに共有の chunk を足さないため・項目が 2 つで組も無い)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_ACCOUNTING_ACCOUNTS,
  normalizeAccountingAccounts,
  resolveAccountingAccounts,
  type AccountingAccounts,
  type AccountSide,
} from '@/lib/accountingAccounts';
import { logger } from '@/lib/logger';
import { safeSet } from '@/lib/storage';

export const ACCOUNTING_ACCOUNTS_STORAGE_KEY = 'openpay:accounting-accounts:v1';

/**
 * 保存値を読む。
 * - readable: false = storage を読めない (getItem が throw)。別のタブの保存値があるかどうかが分からない。
 * - readable: true・value: null = 保存の key が無い・保存値が JSON でない (守る保存値が無い)。
 * - readable: true・value あり = 保存の形にそろえた値 (壊れた項目は、その項目だけ既定 = 空文字)。
 * 失敗の warn は lib/storage.ts の safeGet と同じ (1 回の読みの失敗で 1 回)。safeGet を使わないのは、
 * 「読めない」と「無い」を分けるため。
 */
function readStoredAccounts(): { readable: false } | { readable: true; value: AccountingAccounts | null } {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(ACCOUNTING_ACCOUNTS_STORAGE_KEY);
  } catch (error) {
    logger.warn('localStorage.get failed', { key: ACCOUNTING_ACCOUNTS_STORAGE_KEY, error });
    return { readable: false };
  }
  if (raw === null) return { readable: true, value: null };
  try {
    return { readable: true, value: normalizeAccountingAccounts(JSON.parse(raw)) };
  } catch (error) {
    logger.warn('localStorage.get failed', { key: ACCOUNTING_ACCOUNTS_STORAGE_KEY, error });
    return { readable: true, value: null };
  }
}

export function useAccountingAccounts() {
  const [saved, setSaved] = useState<AccountingAccounts>(EMPTY_ACCOUNTING_ACCOUNTS);
  const [hydrated, setHydrated] = useState(false);
  // 保存の key が無い・JSON でないときに、書き込みの土台に使う「今の名前」(描画のたびに合わせる)。
  const savedRef = useRef(saved);
  savedRef.current = saved;
  // 読めたが書けなかった項目 (容量超過等)。その mount の間は店が入れた名前で書き出せるように、前面に戻ったときの
  // 取り込みで保存値 (前の名前) に戻さず、次に書くときに一緒に書き直す。
  const unsavedRef = useRef<Partial<AccountingAccounts>>({});

  useEffect(() => {
    const pull = () => {
      const stored = readStoredAccounts();
      // 読めない・保存値が無いときは取り込まない: 画面に見えている名前 (= CSV に出る名前) を、読めなかっただけで
      // 既定の科目に戻さない。mount のときは state が既定のままなので、結果は「既定の科目」で同じ。
      if (!stored.readable || stored.value === null) return;
      const next = { ...stored.value, ...unsavedRef.current };
      setSaved((cur) => (cur.debit === next.debit && cur.credit === next.credit ? cur : next));
    };
    pull();
    setHydrated(true);
    const pullWhenVisible = () => {
      if (document.visibilityState !== 'hidden') pull();
    };
    window.addEventListener('focus', pullWhenVisible);
    document.addEventListener('visibilitychange', pullWhenVisible);
    return () => {
      window.removeEventListener('focus', pullWhenVisible);
      document.removeEventListener('visibilitychange', pullWhenVisible);
    };
  }, []);

  /** 1 項目を保存する。name は検証済みの名前か、既定に戻す空文字 (検証を通らない名前・既定と同じ名前は空文字)。 */
  const setAccount = useCallback((side: AccountSide, name: string) => {
    const value = normalizeAccountingAccounts({ [side]: name })[side];
    const stored = readStoredAccounts();
    // 読めないときは書かず、覚えもしない: この変更は、この画面の間だけ使う (画面と CSV には出る)。後から書くと、
    // その間に別のタブが同じ項目に入れた新しい名前を、このタブの古い変更で上書きするため。
    if (stored.readable) {
      // 最新の保存値に、変えた項目 (と、前に書けなかった項目) だけを重ねて書く。保存値が無いときの土台は今の名前。
      const unsaved = { ...unsavedRef.current, [side]: value };
      unsavedRef.current = safeSet(ACCOUNTING_ACCOUNTS_STORAGE_KEY, {
        ...(stored.value ?? savedRef.current),
        ...unsaved,
      })
        ? {}
        : unsaved;
    }
    setSaved((cur) => (cur[side] === value ? cur : { ...cur, [side]: value }));
  }, []);

  /** 実際に使う名前 (検証済みの名前か既定の科目)。hydrate の前は既定の科目。 */
  const accounts = useMemo(() => resolveAccountingAccounts(saved), [saved]);

  return { accounts, setAccount, hydrated };
}
