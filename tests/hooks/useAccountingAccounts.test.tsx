// 会計仕訳 CSV の勘定科目の保存 (hooks/useAccountingAccounts.ts)。
// 保存の形は { debit, credit } で空文字 = 既定の科目。壊れた保存値は既定の科目に倒し、別のタブの変更は
// 前面に戻ったときに取り込む (useLocalStorageSettings の動き・jsdom の 1 つの window を 2 つのタブに見立てる)。
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  ACCOUNTING_ACCOUNTS_STORAGE_KEY,
  useAccountingAccounts,
} from '@/hooks/useAccountingAccounts';

const KEY = ACCOUNTING_ACCOUNTS_STORAGE_KEY;
const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? 'null');

async function mountHook() {
  const view = renderHook(() => useAccountingAccounts());
  await waitFor(() => expect(view.result.current.hydrated).toBe(true));
  return view;
}

/** 別のタブから前面に戻った (window の focus)。 */
function focusTab() {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('useAccountingAccounts', () => {
  it('保存の key は openpay:accounting-accounts:v1', () => {
    expect(KEY).toBe('openpay:accounting-accounts:v1');
  });

  it('保存値が無い → 既定の科目。保存には既定の科目の名前を書き込まない (空文字)', async () => {
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上高' });
    expect(stored()).toEqual({ debit: '', credit: '' });
    expect(window.localStorage.getItem(KEY)).not.toContain('売');
  });

  it('保存値がある → 読み込んだ後はその名前', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ debit: '現金', credit: '売上' }));
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
    expect(stored()).toEqual({ debit: '現金', credit: '売上' });
  });

  it.each([
    ['JSON でない文字列', 'not json'],
    ['配列', JSON.stringify(['現金', '売上'])],
    ['文字列', JSON.stringify('現金')],
    ['null', 'null'],
    ['型の違う項目', JSON.stringify({ debit: 1, credit: { name: '売上' } })],
    ['検証を通らない名前', JSON.stringify({ debit: '=現金', credit: 'あ'.repeat(13) })],
  ])('壊れた保存値 (%s) → 既定の科目', async (_label, raw) => {
    window.localStorage.setItem(KEY, raw);
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上高' });
    // 読み込みの直後に、直した形 (空文字 = 既定) で保存し直す。
    expect(stored()).toEqual({ debit: '', credit: '' });
  });

  it('壊れた項目だけを既定に倒し、通る項目は残す', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ debit: '売上,高', credit: '売上' }));
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
    expect(stored()).toEqual({ debit: '', credit: '売上' });
  });

  it('setAccount で 1 項目を保存し、空文字で既定の科目に戻す', async () => {
    const { result } = await mountHook();
    act(() => result.current.setAccount('credit', '売上'));
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
    expect(stored()).toEqual({ debit: '', credit: '売上' });

    act(() => result.current.setAccount('debit', '現金'));
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
    expect(stored()).toEqual({ debit: '現金', credit: '売上' });

    act(() => result.current.setAccount('credit', ''));
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上高' });
    expect(stored()).toEqual({ debit: '現金', credit: '' });
  });

  it('既定と同じ名前・検証を通らない名前を渡しても、保存は空文字 (既定) になる', async () => {
    const { result } = await mountHook();
    act(() => result.current.setAccount('debit', '現金'));
    act(() => result.current.setAccount('debit', '売掛金'));
    expect(stored()).toEqual({ debit: '', credit: '' });
    act(() => result.current.setAccount('credit', '=売上'));
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上高' });
    expect(stored()).toEqual({ debit: '', credit: '' });
  });

  it('作り直しても (再 mount) 保存値から始まる', async () => {
    const first = await mountHook();
    act(() => first.result.current.setAccount('debit', '現金'));
    first.unmount();
    const second = await mountHook();
    expect(second.result.current.accounts).toEqual({ debit: '現金', credit: '売上高' });
  });

  it('別のタブの変更は、前面に戻ったときに取り込む', async () => {
    const a = await mountHook();
    const b = await mountHook();
    act(() => b.result.current.setAccount('credit', '売上'));
    // 書いた直後には取り込まない。
    expect(a.result.current.accounts.credit).toBe('売上高');
    focusTab();
    expect(a.result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
  });

  it('借方と貸方は別々の単位: 別のタブが貸方を変えた後に借方を変えても、貸方を古い値で消さない', async () => {
    const a = await mountHook();
    const b = await mountHook();
    act(() => b.result.current.setAccount('credit', '売上'));
    act(() => a.result.current.setAccount('debit', '現金'));
    expect(stored()).toEqual({ debit: '現金', credit: '売上' });
    focusTab();
    expect(a.result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
    expect(b.result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
  });

  it('別のタブが書いた検証を通らない値は取り込まない', async () => {
    const a = await mountHook();
    act(() => a.result.current.setAccount('credit', '売上'));
    window.localStorage.setItem(KEY, JSON.stringify({ debit: '=現金', credit: '売上' }));
    focusTab();
    expect(a.result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
  });
});
