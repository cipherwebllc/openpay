// 店舗の設定 (useLocalStorageSettings) の別タブ同期・書き込みの型 (PR26 D10 の Codex レビュー 1・2)。
// 受取先は money に近いので安全側: 別タブの全消去・壊れた値では変えない (既定へ戻さない = 自動補完も走らない)、
// 取り込むのは変わったキーだけ、保存はこのタブが変えたキーだけを最新の保存値に重ねる。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCallback } from 'react';
import { getAddress, type Address } from 'viem';
import { useQrSettings } from '@/hooks/useQrSettings';
import { useReceiverAutofill } from '@/hooks/useReceiverAutofill';

const useAccountMock = vi.fn();
vi.mock('wagmi', () => ({ useAccount: () => useAccountMock() }));

const KEY = 'openpay:qr-settings:v2';
const SAVED: Address = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CONNECTED: Address = getAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

function storageEvent(init: { key: string | null; oldValue?: string | null; newValue?: string | null }) {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: init.key, oldValue: init.oldValue ?? null, newValue: init.newValue ?? null }));
  });
}

/** 決済QR タブと同じ組み合わせ: 設定 + 接続ウォレットからの自動補完。 */
function useQrTab() {
  const { settings, setSettings, hydrated } = useQrSettings();
  const setReceiver = useCallback(
    (value: string, source: 'auto' | 'manual') => setSettings((s) => ({ ...s, receiver: value, receiverSource: source })),
    [setSettings],
  );
  useReceiverAutofill({
    receiver: settings.receiver,
    receiverSource: settings.receiverSource,
    effectiveReceiver: null,
    hydrated,
    setReceiver,
  });
  return { settings, setSettings, hydrated };
}

beforeEach(() => {
  window.localStorage.clear();
  useAccountMock.mockReset();
  useAccountMock.mockReturnValue({ address: CONNECTED, isConnected: true });
});

describe('useLocalStorageSettings: 別タブの消去・壊れた値', () => {
  it('別タブの localStorage.clear() (key === null) では受取先を既定に戻さず、自動補完も走らない', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: SAVED, receiverSource: 'manual', token: 'jpyc' }));
    const { result } = renderHook(() => useQrTab());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.receiver).toBe(SAVED);

    window.localStorage.clear();
    storageEvent({ key: null });
    await act(async () => {});
    expect(result.current.settings.receiver).toBe(SAVED);
    expect(result.current.settings.receiverSource).toBe('manual');
  });

  it('別タブが同じ key を消した (newValue === null)・壊れた JSON を書いたときも受取先を変えない', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: SAVED, receiverSource: 'manual', token: 'jpyc' }));
    const { result } = renderHook(() => useQrTab());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    const old = window.localStorage.getItem(KEY);
    window.localStorage.removeItem(KEY);
    storageEvent({ key: KEY, oldValue: old, newValue: null });
    await act(async () => {});
    expect(result.current.settings.receiver).toBe(SAVED);

    window.localStorage.setItem(KEY, '{broken');
    storageEvent({ key: KEY, oldValue: old, newValue: '{broken' });
    await act(async () => {});
    expect(result.current.settings.receiver).toBe(SAVED);
    expect(result.current.settings.receiverSource).toBe('manual');

    window.localStorage.setItem(KEY, '"text"');
    storageEvent({ key: KEY, oldValue: '{broken', newValue: '"text"' });
    await act(async () => {});
    expect(result.current.settings.receiver).toBe(SAVED);
  });
});

describe('useLocalStorageSettings: 変わったキーだけ取り込む・変えたキーだけ保存する', () => {
  it('別タブの保存値からは変わったキーだけ取り込む (このタブで入力中の受取先は戻らない)', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: '0xold', receiverSource: 'manual', token: 'jpyc', storeName: '' }));
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    // このタブ (A) で受取先を入力中。
    act(() => {
      result.current.setSettings((s) => ({ ...s, receiver: '0xtyping' }));
    });
    await waitFor(() => expect(result.current.settings.receiver).toBe('0xtyping'));

    // タブ B は storage イベントを処理する前の古い設定 (receiver '0xold') から店名だけ変えて保存した。
    const old = JSON.stringify({ receiver: '0xold', receiverSource: 'manual', token: 'jpyc', storeName: '' });
    const fromB = JSON.stringify({ receiver: '0xold', receiverSource: 'manual', token: 'jpyc', storeName: 'Cafe B' });
    window.localStorage.setItem(KEY, fromB);
    storageEvent({ key: KEY, oldValue: old, newValue: fromB });
    await waitFor(() => expect(result.current.settings.storeName).toBe('Cafe B'));
    expect(result.current.settings.receiver).toBe('0xtyping');
  });

  it('保存はこのタブが変えたキーだけを最新の保存値に重ねる (古い state のタブが別タブの受取先を上書きしない)', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: '0xold', receiverSource: 'manual', token: 'jpyc' }));
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    // タブ A が受取先を変えて保存したが、このタブ (B) にはまだ storage イベントが届いていない (古い state のまま)。
    const saved = JSON.parse(window.localStorage.getItem(KEY)!);
    window.localStorage.setItem(KEY, JSON.stringify({ ...saved, receiver: '0xnew', invoiceNo: 'T1234567890123' }));

    // B で店名だけ変える。
    act(() => {
      result.current.setSettings((s) => ({ ...s, storeName: 'Cafe B' }));
    });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).storeName).toBe('Cafe B'));
    const onDisk = JSON.parse(window.localStorage.getItem(KEY)!);
    expect(onDisk.receiver).toBe('0xnew');
    expect(onDisk.invoiceNo).toBe('T1234567890123');
  });

  it('hydrate 直後の 1 回は全体を書く (旧 schema の移行) ・その後は変えたキーだけ', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: '0xa', token: 'jpyc', directTransfer: true }));
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).payMode).toBe('standard'));
    const migrated = JSON.parse(window.localStorage.getItem(KEY)!);
    expect('directTransfer' in migrated).toBe(false);
    expect(migrated.quickAmounts).toEqual({ jpyc: ['500', '1000', '1500', '3000'], usdc: ['5', '10', '20', '50'] });
  });

  it('最新の保存値が読めない (消えた・壊れた) ときは設定全体を書く (変えたキーだけで上書きして他を失わない)', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ receiver: '0xa', token: 'jpyc' }));
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).receiver).toBe('0xa'));

    window.localStorage.setItem(KEY, '{broken');
    act(() => {
      result.current.setSettings((s) => ({ ...s, storeName: 'Cafe' }));
    });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(KEY)!).storeName).toBe('Cafe'));
    expect(JSON.parse(window.localStorage.getItem(KEY)!).receiver).toBe('0xa');
  });
});
