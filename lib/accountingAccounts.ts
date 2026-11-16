// 会計仕訳 CSV (lib/accountingCsv.ts) の勘定科目の名前。店が変えられる (既定は 売掛金 / 売上高)。
// 画面 (components/HistoryToolbar.tsx)・保存 (hooks/useAccountingAccounts.ts)・CSV の生成が同じ検証を使う。
//
// 保存の形は { debit, credit } で、空文字 = 既定の科目 (店が変えた名前だけを持つ)。
// CSV や画面に出すときは resolveAccountingAccounts で実際の名前にする。

import { startsWithCsvFormulaChar } from './csv';

export type AccountingAccounts = {
  /** 借方 (受け取り) の勘定科目。freee 形式 (単式) では使わない。 */
  debit: string;
  /** 貸方 (売上) の勘定科目。 */
  credit: string;
};

export type AccountSide = keyof AccountingAccounts;

export const DEFAULT_ACCOUNTING_ACCOUNTS: Readonly<AccountingAccounts> = {
  debit: '売掛金',
  credit: '売上高',
};

/** 保存の形での既定 (どちらも店が変えていない)。 */
export const EMPTY_ACCOUNTING_ACCOUNTS: Readonly<AccountingAccounts> = {
  debit: '',
  credit: '',
};

// 名前の上限 (code point で数える・全角も半角も 1 字)。取込側で確かめた中でいちばん短い上限
// (弥生会計 オンライン 12 文字・弥生会計 デスクトップ 半角 24 桁 = 全角 12 字) に合わせる。
export const ACCOUNT_NAME_MAX_CHARS = 12;

// CSV の区切り (`,` `"`) と、見えない字 (制御文字・ゼロ幅などの書式文字・孤立した surrogate・行と段落の区切り)。
// 会計ソフトに登録した科目名と見た目が同じでも一致しなくなる字を、入力のときに弾く。
const FORBIDDEN_RE = /[,"\u2028\u2029\p{Cc}\p{Cf}\p{Cs}]/u;

export type AccountNameError = 'empty' | 'forbidden' | 'formula' | 'tooLong';

export type AccountNameCheck =
  | { ok: true; value: string }
  | { ok: false; reason: AccountNameError };

/**
 * 勘定科目の名前を検証する。前後の空白 (全角の空白を含む) を除き NFC にそろえてから見る。
 * 通ったときの value が、保存と CSV に使う名前。
 */
export function checkAccountName(raw: string): AccountNameCheck {
  const value = raw.trim().normalize('NFC');
  if (value === '') return { ok: false, reason: 'empty' };
  if (FORBIDDEN_RE.test(value)) return { ok: false, reason: 'forbidden' };
  // 先頭が数式の字だと CSV の escape が `'` を前に付け、会計ソフトの科目名と一致しなくなる。
  if (startsWithCsvFormulaChar(value)) return { ok: false, reason: 'formula' };
  if ([...value].length > ACCOUNT_NAME_MAX_CHARS) return { ok: false, reason: 'tooLong' };
  return { ok: true, value };
}

function normalizeName(raw: unknown, side: AccountSide): string {
  if (typeof raw !== 'string') return '';
  const checked = checkAccountName(raw);
  if (!checked.ok) return '';
  // 既定と同じ名前は「変えていない」と同じ (保存の形を 1 つにする)。
  return checked.value === DEFAULT_ACCOUNTING_ACCOUNTS[side] ? '' : checked.value;
}

/**
 * 保存値・引数を保存の形にそろえる (冪等)。項目ごとに、文字列でない・検証を通らない・既定と同じ名前は
 * 空文字 (= 既定) にする。
 */
export function normalizeAccountingAccounts(raw: unknown): AccountingAccounts {
  const source =
    raw !== null && typeof raw === 'object' ? (raw as Partial<Record<AccountSide, unknown>>) : {};
  return {
    debit: normalizeName(source.debit, 'debit'),
    credit: normalizeName(source.credit, 'credit'),
  };
}

/** 実際に使う名前 (検証済みの名前か既定の科目)。画面の見出し・入力・CSV はこの値から出す (冪等)。 */
export function resolveAccountingAccounts(raw: unknown): AccountingAccounts {
  const normalized = normalizeAccountingAccounts(raw);
  return {
    debit: normalized.debit || DEFAULT_ACCOUNTING_ACCOUNTS.debit,
    credit: normalized.credit || DEFAULT_ACCOUNTING_ACCOUNTS.credit,
  };
}
