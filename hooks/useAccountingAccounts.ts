'use client';

// 会計仕訳 CSV の勘定科目 (店が変えた名前) を、この端末の localStorage に残す。
// 保存の形は { debit, credit } で、空文字 = 既定の科目 (lib/accountingAccounts.ts)。
// - 読むのは mount のときと、このタブが前面に戻ったとき (focus・visibilitychange で visible)。mount では書かない
//   (履歴ページを開くだけで保存の key を作らない)。hydrate の前は既定の科目。
// - 書くのは setAccount のときだけで、その場で (同期で) 書く。最新の保存値を読み直し、変えた項目だけを置き換える
//   (古い state の全体を書くと、別のタブが変えたもう片方の項目を消すため)。読み直しと書き込みは 1 つの同期の処理で、
//   タブをまたぐロックは取らない: 2 つのタブが同じ瞬間 (この処理の途中) に別々の項目を確定したときだけ、先に書いた
//   方の項目が消え得る (残る限界。人の操作では起きない間隔)。
// - 保存値が無い・読めないときは、今の名前を保つ (見えている名前を、読めなかっただけで既定の科目に戻さない)。
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

/**
 * 保存値を保存の形で読む。壊れた項目は、その項目だけ既定 (空文字)。
 * 保存の key が無い・読めない (storage が throw・JSON でない) ときは null — 呼ぶ側は、今の名前を保つ。
 */
function readStoredAccounts(): AccountingAccounts | null {
  const raw = safeGet<unknown>(ACCOUNTING_ACCOUNTS_STORAGE_KEY, undefined);
  return raw === undefined ? null : normalizeAccountingAccounts(raw);
}

export function useAccountingAccounts() {
  const [saved, setSaved] = useState<AccountingAccounts>(EMPTY_ACCOUNTING_ACCOUNTS);
  const [hydrated, setHydrated] = useState(false);
  // setAccount が、保存値を読めないときの土台に使う「今の名前」(描画のたびに合わせる)。
  const savedRef = useRef(saved);
  savedRef.current = saved;
  // 書けなかった項目 (容量超過・private mode 等)。その mount の間は店が入れた名前で書き出せるように、前面に戻った
  // ときの取り込みで保存値 (前の名前) に戻さず、次に書くときに一緒に書き直す。
  const unsavedRef = useRef<Partial<AccountingAccounts>>({});

  useEffect(() => {
    const pull = () => {
      const stored = readStoredAccounts();
      // 保存値が無い・読めないときは取り込まない: 画面に見えている名前 (= CSV に出る名前) を、読めなかっただけで
      // 既定の科目に戻さない。mount のときは state が既定のままなので、結果は「既定の科目」で同じ。
      if (stored === null) return;
      const next = { ...stored, ...unsavedRef.current };
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
    // 土台は最新の保存値。無い (初めての保存)・読めないときは、今の名前 (もう片方の項目を既定で消さない)。
    unsavedRef.current = safeSet(ACCOUNTING_ACCOUNTS_STORAGE_KEY, {
      ...(readStoredAccounts() ?? savedRef.current),
      ...unsaved,
    })
      ? {}
      : unsaved;
    // 同じ処理の中で続けて呼ばれても (書き出しのときに 2 つの入力を続けて確定する)、次の呼び出しの土台に
    // この項目が入っているように、描画を待たずに合わせておく。
    savedRef.current = { ...savedRef.current, [side]: value };
    setSaved((cur) => (cur[side] === value ? cur : { ...cur, [side]: value }));
  }, []);

  /** 実際に使う名前 (検証済みの名前か既定の科目)。hydrate の前は既定の科目。 */
  const accounts = useMemo(() => resolveAccountingAccounts(saved), [saved]);

  return { accounts, setAccount, hydrated };
}
