// 会計仕訳 CSV の勘定科目の保存 (hooks/useAccountingAccounts.ts)。
// 保存の形は { debit, credit } で空文字 = 既定の科目。mount では読むだけで書かない。setAccount のときに、その場で
// (同期で) 最新の保存値の 1 項目だけを置き換えて書く。別のタブの変更は、このタブが前面に戻ったとき
// (focus・visibilitychange で visible) に取り込む (jsdom の 1 つの window を 2 つのタブに見立てる)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { logger } from '@/lib/logger';
import {
  ACCOUNTING_ACCOUNTS_STORAGE_KEY,
  useAccountingAccounts,
} from '@/hooks/useAccountingAccounts';

const KEY = ACCOUNTING_ACCOUNTS_STORAGE_KEY;
const DEFAULTS = { debit: '売掛金', credit: '売上高' };
const raw = () => window.localStorage.getItem(KEY);
const stored = () => JSON.parse(raw() ?? 'null');
const save = (value: unknown) => window.localStorage.setItem(KEY, JSON.stringify(value));

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

/** タブの表示の状態が変わった (visibilitychange)。 */
function changeVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  // changeVisibility が document に足した値を外す (prototype の値に戻す)。
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('useAccountingAccounts: 読み込み (mount では書かない)', () => {
  it('保存の key は openpay:accounting-accounts:v1', () => {
    expect(KEY).toBe('openpay:accounting-accounts:v1');
  });

  it('保存値が無い → 既定の科目。開いただけでは保存の key を作らない', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual(DEFAULTS);
    expect(raw()).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('hydrate の前は既定の科目 (保存値があっても)。読んだ後は保存値', async () => {
    save({ debit: '現金', credit: '売上' });
    const renders: { accounts: typeof DEFAULTS; hydrated: boolean }[] = [];
    const { result } = renderHook(() => {
      const r = useAccountingAccounts();
      renders.push({ accounts: r.accounts, hydrated: r.hydrated });
      return r;
    });
    expect(renders[0]).toEqual({ accounts: DEFAULTS, hydrated: false });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
  });

  it('保存値がある → 読み込んだ後はその名前。読むだけで書き直さない', async () => {
    window.localStorage.setItem(KEY, '{"credit":"売上","debit":"現金"}');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
    expect(raw()).toBe('{"credit":"売上","debit":"現金"}');
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON でない文字列', 'not json'],
    ['配列', JSON.stringify(['現金', '売上'])],
    ['文字列', JSON.stringify('現金')],
    ['null', 'null'],
    ['型の違う項目', JSON.stringify({ debit: 1, credit: { name: '売上' } })],
    ['検証を通らない名前', JSON.stringify({ debit: '=現金', credit: 'あ'.repeat(13) })],
  ])('壊れた保存値 (%s) → 既定の科目。mount では書き直さない', async (_label, value) => {
    window.localStorage.setItem(KEY, value);
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual(DEFAULTS);
    expect(raw()).toBe(value);
  });

  it('壊れた項目だけを既定に倒し、通る項目は残す', async () => {
    save({ debit: '売上,高', credit: '売上' });
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
  });

  it('読めない環境 (getItem が throw) → 既定の科目 (warn は safeGet の今の動き)', async () => {
    save({ debit: '現金', credit: '売上' });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual(DEFAULTS);
    // mount の読み 1 回の失敗で warn 1 回 (safeGet と同じ回数)。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('localStorage.get failed', expect.objectContaining({ key: KEY }));
  });

  it('作り直しても (再 mount) 保存値から始まる', async () => {
    const first = await mountHook();
    act(() => first.result.current.setAccount('debit', '現金'));
    first.unmount();
    const second = await mountHook();
    expect(second.result.current.accounts).toEqual({ debit: '現金', credit: '売上高' });
  });
});

describe('useAccountingAccounts: 保存 (setAccount)', () => {
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
    expect(result.current.accounts).toEqual(DEFAULTS);
    expect(stored()).toEqual({ debit: '', credit: '' });
  });

  it('その場で (同期で) 書く: 呼んだ直後に保存値がある。Web Locks を待たない', async () => {
    // Web Locks が返らない環境を作る (ロックの中で書く作りなら、いつまでも書かれない)。
    const request = vi.fn(() => new Promise<never>(() => undefined));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      const { result } = await mountHook();
      let inHandler: unknown = 'not read';
      act(() => {
        result.current.setAccount('credit', '売上');
        // 描画し直す前 (同じ処理の中) に読む。
        inHandler = stored();
      });
      expect(inHandler).toEqual({ debit: '', credit: '売上' });
      expect(request).not.toHaveBeenCalled();
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  it('書くときは最新の保存値を読み直す: 別のタブが貸方を変えた後に借方を変えても、貸方を消さない', async () => {
    const a = await mountHook();
    const b = await mountHook();
    act(() => b.result.current.setAccount('credit', '売上'));
    // a は前面に戻っていない (a の貸方は古いまま) が、書くのは借方の 1 項目だけ。
    act(() => a.result.current.setAccount('debit', '現金'));
    expect(stored()).toEqual({ debit: '現金', credit: '売上' });
    focusTab();
    expect(a.result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
    expect(b.result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
  });

  it('書くときは、読み直した保存値の壊れた項目・余分な key を保存の形にそろえる', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ debit: '=現金', credit: '売上', extra: 1 }));
    const { result } = await mountHook();
    act(() => result.current.setAccount('credit', '収入'));
    expect(raw()).toBe(JSON.stringify({ debit: '', credit: '収入' }));
  });

  it('書けない環境: state は変えたまま (その mount の間は使える)。warn は safeSet の今の動き', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const { result } = await mountHook();
    act(() => result.current.setAccount('credit', '売上'));
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
    expect(raw()).toBeNull();
    // 書き込み 1 回の失敗で warn 1 回 (safeSet の今の動き)。読みは成功しているので get の warn は無い。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('localStorage.set failed', expect.objectContaining({ key: KEY }));
  });

  it('書けなかった項目は、前面に戻ったときの取り込みで保存値に戻さず、次に書けたときに一緒に書く', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    save({ debit: '', credit: '売上' });
    const { result } = await mountHook();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    act(() => result.current.setAccount('credit', '収入'));
    expect(stored()).toEqual({ debit: '', credit: '売上' });
    focusTab();
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '収入' });

    // 次の書き込み (借方) が通ると、書けなかった貸方も一緒に書く。
    act(() => result.current.setAccount('debit', '現金'));
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual({ debit: '現金', credit: '収入' });
    // 書けた後は、別のタブの変更を普通に取り込む。
    save({ debit: '現金', credit: '別タブ売上' });
    focusTab();
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '別タブ売上' });
  });
});

describe('useAccountingAccounts: 別のタブの変更の取り込み', () => {
  it('前面に戻ったとき (focus) に取り込む。書いた直後には取り込まない', async () => {
    const a = await mountHook();
    const b = await mountHook();
    act(() => b.result.current.setAccount('credit', '売上'));
    expect(a.result.current.accounts.credit).toBe('売上高');
    focusTab();
    expect(a.result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
  });

  it('visibilitychange: visible に戻ったときに取り込み、hidden になったときには取り込まない', async () => {
    const { result } = await mountHook();
    save({ debit: '', credit: '売上' });
    changeVisibility('hidden');
    expect(result.current.accounts.credit).toBe('売上高');
    changeVisibility('visible');
    expect(result.current.accounts.credit).toBe('売上');
  });

  it('前面に戻ったときも、壊れた項目は既定の科目 (読み込み直したときと同じ)', async () => {
    const { result } = await mountHook();
    act(() => result.current.setAccount('debit', '現金'));
    window.localStorage.setItem(KEY, JSON.stringify({ debit: '=現金', credit: '売上' }));
    focusTab();
    expect(result.current.accounts).toEqual({ debit: '売掛金', credit: '売上' });
  });

  it('前面に戻ったときに保存値を読めない (getItem が throw) → 今の名前を保つ (既定の科目に戻さない)', async () => {
    save({ debit: '現金', credit: '売上' });
    const { result } = await mountHook();
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    focusTab();
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
  });

  it.each([
    ['保存の key が消えた (別のタブが保存を消した)', () => window.localStorage.removeItem(KEY)],
    ['保存値が JSON でない', () => window.localStorage.setItem(KEY, '{not json')],
  ])('前面に戻ったときに %s → 今の名前を保つ', async (_label, breakStorage) => {
    save({ debit: '現金', credit: '売上' });
    const { result } = await mountHook();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    breakStorage();
    focusTab();
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上' });
  });

  it('storage を読めない (getItem が throw) ときは書かない: この画面の間だけ新しい名前・保存値はそのまま・後からも書かない', async () => {
    save({ debit: '現金', credit: '売上' });
    const { result } = await mountHook();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    act(() => {
      // 書き出しのときと同じく、同じ処理の中で 2 項目を続けて確定する。
      result.current.setAccount('debit', '普通預金');
      result.current.setAccount('credit', '売上金');
    });
    expect(setItem).not.toHaveBeenCalled();
    // 読みの失敗 1 回につき warn 1 回 (safeGet と同じ)。書いていないので set の warn は無い。
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('localStorage.get failed', expect.objectContaining({ key: KEY }));
    // 画面 (と CSV) は、この画面の間は新しい名前。
    expect(result.current.accounts).toEqual({ debit: '普通預金', credit: '売上金' });
    // 読めないまま前面に戻っても、新しい名前のまま。
    focusTab();
    expect(result.current.accounts).toEqual({ debit: '普通預金', credit: '売上金' });
    getItem.mockRestore();
    expect(stored()).toEqual({ debit: '現金', credit: '売上' });
    // 読めるようになった次の書き込みは、その項目だけ。読めない間の変更 (借方) は後から書かない。
    act(() => result.current.setAccount('credit', '売上金'));
    expect(stored()).toEqual({ debit: '現金', credit: '売上金' });
    // 前面に戻ると、保存値に合わせる (画面の名前 = 保存値 = CSV の名前)。
    focusTab();
    expect(result.current.accounts).toEqual({ debit: '現金', credit: '売上金' });
  });

  it('別のタブが貸方を既定に戻した後、このタブが storage を読めないまま借方を変えても、貸方を前の名前に戻さない', async () => {
    save({ debit: '現金', credit: '売上' });
    const a = await mountHook();
    const b = await mountHook();
    act(() => b.result.current.setAccount('credit', ''));
    expect(stored()).toEqual({ debit: '現金', credit: '' });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    act(() => a.result.current.setAccount('debit', '普通預金'));
    getItem.mockRestore();
    // A の古い state (貸方 = 売上) の全体では書かない。
    expect(stored()).toEqual({ debit: '現金', credit: '' });
    // 読めるようになって前面に戻ると、保存値に合わせる (B の変更を取り込み、読めない間の A の変更は残さない)。
    focusTab();
    expect(a.result.current.accounts).toEqual({ debit: '現金', credit: '売上高' });
    act(() => a.result.current.setAccount('debit', '普通預金'));
    expect(stored()).toEqual({ debit: '普通預金', credit: '' });
  });

  it('このタブが storage を読めない間に借方を変え、その後に別のタブが借方を保存しても、後の書き込みで別のタブの借方を上書きしない', async () => {
    save({ debit: '現金', credit: '売上' });
    const a = await mountHook();
    const b = await mountHook();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    act(() => a.result.current.setAccount('debit', '普通預金'));
    getItem.mockRestore();
    act(() => b.result.current.setAccount('debit', '当座預金'));
    expect(stored()).toEqual({ debit: '当座預金', credit: '売上' });
    // 読めるようになった A が貸方を確定しても、B の借方 (後から保存された名前) は残る。
    act(() => a.result.current.setAccount('credit', '売上金'));
    expect(stored()).toEqual({ debit: '当座預金', credit: '売上金' });
    focusTab();
    expect(a.result.current.accounts).toEqual({ debit: '当座預金', credit: '売上金' });
  });

  it.each([
    ['保存の key が無い', () => window.localStorage.removeItem(KEY)],
    ['保存値が JSON でない', () => window.localStorage.setItem(KEY, '{not json')],
  ])('%s ときに 1 項目を書くと、もう片方は今の名前のまま書く (既定で消さない)', async (_label, breakStorage) => {
    save({ debit: '現金', credit: '売上' });
    const { result } = await mountHook();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    breakStorage();
    act(() => result.current.setAccount('debit', '普通預金'));
    expect(stored()).toEqual({ debit: '普通預金', credit: '売上' });
    expect(result.current.accounts).toEqual({ debit: '普通預金', credit: '売上' });
  });

  it('unmount した後は取り込まない (listener を外す)', async () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const view = await mountHook();
    view.unmount();
    expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
