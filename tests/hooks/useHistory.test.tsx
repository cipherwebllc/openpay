import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useHistory } from '@/hooks/useHistory';
import {
  appendHistory,
  clearHistory,
  HISTORY_CHANGED_EVENT,
  HISTORY_STORAGE_KEY,
  removeHistoryEntry,
  type HistoryEntry,
} from '@/lib/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    schemaVersion: 1,
    id: 'test-id',
    ts: 1_700_000_000_000,
    flow: 'batch',
    status: 'success',
    chainId: 137,
    chainSlug: 'polygon',
    asset: 'jpyc',
    tokenAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
    payMode: 'gasless',
    gasMode: 'customer',
    merchant: '0xMerchant',
    merchantAmount: '1000',
    customer: '0xCustomer',
    feeReceiver: '0xFee',
    feeAmount: '10',
    txHash: '0xTx',
    userOpHash: '0xUserOp',
    blockNumber: '12345',
    errorMessage: null,
    storeName: 'Test Store',
    note: '',
    provider: null,
    circlePaymasterAddress: null,
    circlePaymasterNetUsdc: null,
    circleVerification: null,
    ...overrides,
  };
}

describe('useHistory', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('初期 LocalStorage 値を hydrate 後に load する', async () => {
    window.localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify([entry({ id: 'a' }), entry({ id: 'b' })]),
    );
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('appendHistory → CustomEvent 経由で state が再 load される', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.entries).toHaveLength(0);

    act(() => {
      appendHistory(entry({ id: 'new' }));
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0].id).toBe('new');
  });

  it('clearHistory → state も空になる', async () => {
    appendHistory(entry({ id: 'x' }));
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    act(() => {
      clearHistory();
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(0));
  });

  it('removeHistoryEntry → 該当 id が消える', async () => {
    appendHistory(entry({ id: 'a' }));
    appendHistory(entry({ id: 'b' }));
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));

    act(() => {
      removeHistoryEntry('a');
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0].id).toBe('b');
  });

  it('他タブからの storage event (HISTORY_STORAGE_KEY) で再 load する', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    // 別タブが LocalStorage を直接書き換えた状況を再現
    window.localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify([entry({ id: 'from-other-tab' })]),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: HISTORY_STORAGE_KEY,
          newValue: 'whatever',
        }),
      );
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0].id).toBe('from-other-tab');
  });

  it('別 key の storage event は無視する', async () => {
    appendHistory(entry({ id: 'a' }));
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    // 別アプリの key の write
    window.localStorage.setItem('unrelated-key', 'x');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'unrelated-key', newValue: 'x' }),
      );
    });
    // state は変化しない
    expect(result.current.entries).toHaveLength(1);
  });

  it('clear() による key=null storage event でも再 load する', async () => {
    appendHistory(entry({ id: 'a' }));
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    window.localStorage.removeItem(HISTORY_STORAGE_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    await waitFor(() => expect(result.current.entries).toHaveLength(0));
  });

  describe('unmount で event listener cleanup (実証)', () => {
    let addSpy: ReturnType<typeof vi.spyOn>;
    let removeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      addSpy = vi.spyOn(window, 'addEventListener');
      removeSpy = vi.spyOn(window, 'removeEventListener');
    });

    afterEach(() => {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('mount: storage + HISTORY_CHANGED_EVENT 2 つの listener が登録される', async () => {
      const { result } = renderHook(() => useHistory());
      await waitFor(() => expect(result.current.hydrated).toBe(true));
      expect(addSpy).toHaveBeenCalledWith('storage', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith(
        HISTORY_CHANGED_EVENT,
        expect.any(Function),
      );
    });

    it('unmount: addEventListener で渡したのと同じ handler が removeEventListener に渡る', async () => {
      const { result, unmount } = renderHook(() => useHistory());
      await waitFor(() => expect(result.current.hydrated).toBe(true));

      // mount 時の handler 参照を addSpy から抜き出す
      const storageAddCall = addSpy.mock.calls.find(
        ([name]) => name === 'storage',
      );
      const customAddCall = addSpy.mock.calls.find(
        ([name]) => name === HISTORY_CHANGED_EVENT,
      );
      expect(storageAddCall).toBeDefined();
      expect(customAddCall).toBeDefined();
      const storageHandler = storageAddCall![1];
      const customHandler = customAddCall![1];

      unmount();

      // 同一 handler 参照で removeEventListener が呼ばれている
      expect(removeSpy).toHaveBeenCalledWith('storage', storageHandler);
      expect(removeSpy).toHaveBeenCalledWith(
        HISTORY_CHANGED_EVENT,
        customHandler,
      );
    });

    it('unmount 後の appendHistory: listener が解除済なので setEntries は呼ばれない', async () => {
      const { result, unmount } = renderHook(() => useHistory());
      await waitFor(() => expect(result.current.hydrated).toBe(true));

      unmount();

      // 別 hook を新規 mount しても干渉しないよう localStorage を直接書く
      appendHistory(entry({ id: 'after-unmount' }));
      // LocalStorage には実際入っている (副作用は走った)
      const rawAfter = window.localStorage.getItem(HISTORY_STORAGE_KEY);
      expect(rawAfter).toContain('after-unmount');
      // unmounted hook の result は変化しない
      expect(result.current.entries).toHaveLength(0);
    });
  });
});
