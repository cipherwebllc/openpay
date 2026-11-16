'use client';

// 会計仕訳 CSV の勘定科目 (店が変えた名前) を、この端末の localStorage に残す。
// 保存の形は { debit, credit } で、空文字 = 既定の科目 (lib/accountingAccounts.ts)。
// - 読むのは mount のときと、このタブが前面に戻ったとき (focus・visibilitychange で visible)。mount では書かない
//   (履歴ページを開くだけで保存の key を作らない)。hydrate の前は既定の科目。
// - 書くのは setAccount のときだけで、その場で (同期で) 書く。最新の保存値を読み直し、変えた項目だけを置き換える
//   (古い state の全体を書くと、別のタブが変えたもう片方の項目を消すため)。
// 共通の useLocalStorageSettings は使わない (履歴ページに共有の chunk を足さないため・項目が 2 つで組も無い)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_ACCOUNTING_ACCOUNTS,
  normalizeAccountingAccounts,
  resolveAccountingAccounts,
  type AccountingAccounts,
  type AccountSide,
} from '@/lib/accountingAccounts';
import { safeGet, safeSet } from '@/lib/storage';

export const ACCOUNTING_ACCOUNTS_STORAGE_KEY = 'openpay:accounting-accounts:v1';

/** 保存値を保存の形で読む。無い・読めない・壊れた値は、その項目ごとに既定 (空文字)。 */
function readStoredAccounts(): AccountingAccounts {
  return normalizeAccountingAccounts(safeGet<unknown>(ACCOUNTING_ACCOUNTS_STORAGE_KEY, null));
}

export function useAccountingAccounts() {
  const [saved, setSaved] = useState<AccountingAccounts>(EMPTY_ACCOUNTING_ACCOUNTS);
  const [hydrated, setHydrated] = useState(false);
  // 書けなかった項目 (容量超過・private mode 等)。その mount の間は店が入れた名前で書き出せるように、前面に戻った
  // ときの取り込みで保存値 (前の名前) に戻さず、次に書くときに一緒に書き直す。
  const unsavedRef = useRef<Partial<AccountingAccounts>>({});

  useEffect(() => {
    const pull = () => {
      const next = { ...readStoredAccounts(), ...unsavedRef.current };
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
    const unsaved = { ...unsavedRef.current, [side]: value };
    unsavedRef.current = safeSet(ACCOUNTING_ACCOUNTS_STORAGE_KEY, {
      ...readStoredAccounts(),
      ...unsaved,
    })
      ? {}
      : unsaved;
    setSaved((cur) => (cur[side] === value ? cur : { ...cur, [side]: value }));
  }, []);

  /** 実際に使う名前 (検証済みの名前か既定の科目)。hydrate の前は既定の科目。 */
  const accounts = useMemo(() => resolveAccountingAccounts(saved), [saved]);

  return { accounts, setAccount, hydrated };
}
