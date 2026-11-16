'use client';

// 会計仕訳 CSV の勘定科目 (店が変えた名前) を、この端末の localStorage に残す。
// 保存の形は { debit, credit } で、空文字 = 既定の科目 (lib/accountingAccounts.ts)。初めて開いたときに
// 既定の科目の名前は書き込まない (書くのは空文字)。
// 別のタブとの同期は借方と貸方を別々の単位のまま (片方だけを別のタブの値にしても意味は変わらない)。

import { useCallback, useMemo } from 'react';
import {
  EMPTY_ACCOUNTING_ACCOUNTS,
  normalizeAccountingAccounts,
  resolveAccountingAccounts,
  type AccountingAccounts,
  type AccountSide,
} from '@/lib/accountingAccounts';
import { useLocalStorageSettings } from './useLocalStorageSettings';

export const ACCOUNTING_ACCOUNTS_STORAGE_KEY = 'openpay:accounting-accounts:v1';

// useLocalStorageSettings の effect の依存になるので、既定値と sanitize は module の定数にする。
const DEFAULT_SETTINGS: AccountingAccounts = { ...EMPTY_ACCOUNTING_ACCOUNTS };

function sanitize(loaded: Partial<AccountingAccounts>): AccountingAccounts {
  return normalizeAccountingAccounts(loaded);
}

export function useAccountingAccounts() {
  const { settings, setSettings, hydrated } = useLocalStorageSettings<AccountingAccounts>(
    ACCOUNTING_ACCOUNTS_STORAGE_KEY,
    DEFAULT_SETTINGS,
    sanitize,
  );

  /** 実際に使う名前 (検証済みの名前か既定の科目)。hydrate の前は既定の科目。 */
  const accounts = useMemo(() => resolveAccountingAccounts(settings), [settings]);

  /** 1 項目を保存する。name は検証済みの名前か、既定に戻す空文字。 */
  const setAccount = useCallback(
    (side: AccountSide, name: string) => {
      setSettings((prev) => {
        const next = normalizeAccountingAccounts({ ...prev, [side]: name });
        // 変わらないときは同じ参照を返す (保存の書き込みを起こさない)。
        return next.debit === prev.debit && next.credit === prev.credit ? prev : next;
      });
    },
    [setSettings],
  );

  return { accounts, setAccount, hydrated };
}
