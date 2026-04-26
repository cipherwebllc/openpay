import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQrSettings } from '@/hooks/useQrSettings';

const KEY = 'openpay:qr-settings:v1';

describe('useQrSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存時は defaults (usdc / include / 空アドレス / directTransfer=false)', async () => {
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '',
      token: 'usdc',
      fee: 'include',
      directTransfer: false,
    });
  });

  it('保存値からハイドレート (directTransfer フィールドが無い旧データ → false で埋める)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'jpyc',
        fee: 'exclude',
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('jpyc');
    expect(result.current.settings.fee).toBe('exclude');
    expect(result.current.settings.receiver).toBe('0xabc');
    expect(result.current.settings.directTransfer).toBe(false);
  });

  it('directTransfer=true の保存値もハイドレート', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'usdc',
        fee: 'include',
        directTransfer: true,
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.directTransfer).toBe(true);
  });

  it('破損 JSON → defaults', async () => {
    window.localStorage.setItem(KEY, '{not-json');
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('usdc');
  });

  it('部分的に不正な値 → default で埋める (token 不正)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'btc', fee: 'exclude', receiver: '0xa' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('usdc'); // default
    expect(result.current.settings.fee).toBe('exclude'); // 保持
    expect(result.current.settings.receiver).toBe('0xa');
  });

  it('部分的に不正な値 → default で埋める (fee 不正)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', fee: 'tax-free', receiver: '' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('jpyc');
    expect(result.current.settings.fee).toBe('include'); // default
  });

  it('setSettings で更新 → localStorage へ書込 (directTransfer 含む)', async () => {
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.setSettings({
        receiver: '0xdef',
        token: 'jpyc',
        fee: 'exclude',
        directTransfer: true,
      });
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.token).toBe('jpyc');
      expect(parsed.fee).toBe('exclude');
      expect(parsed.receiver).toBe('0xdef');
      expect(parsed.directTransfer).toBe(true);
    });
  });

  it('hydrate 完了前は localStorage に書込まない (上書き防止)', async () => {
    // ハイドレート未完了の瞬間にデフォルト値で localStorage を上書きしてしまう
    // バグを防いでいるかを検証
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ receiver: '0xkeep', token: 'jpyc', fee: 'exclude' }),
    );
    renderHook(() => useQrSettings());
    // 初回 render 直後 (まだ useEffect 実行前) では既存値が残っているはず
    const initial = window.localStorage.getItem(KEY);
    expect(initial).toContain('0xkeep');
  });
});
