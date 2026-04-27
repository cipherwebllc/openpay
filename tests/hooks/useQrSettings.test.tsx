import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQrSettings } from '@/hooks/useQrSettings';

const KEY = 'openpay:qr-settings:v2';

describe('useQrSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存時は defaults', async () => {
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '',
      token: 'usdc',
      directTransfer: false,
      splits: [],
    });
  });

  it('保存値からハイドレート (旧スキーマ: directTransfer/splits なし → default 補完)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'jpyc',
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('jpyc');
    expect(result.current.settings.receiver).toBe('0xabc');
    expect(result.current.settings.directTransfer).toBe(false);
    expect(result.current.settings.splits).toEqual([]);
  });

  it('directTransfer=true の保存値もハイドレート', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'usdc',
        directTransfer: true,
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.directTransfer).toBe(true);
  });

  it('splits 配列をハイドレート (最大 3 件まで)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'usdc',
        directTransfer: false,
        splits: [
          { address: '0xb1', percent: '30' },
          { address: '0xb2', percent: '20' },
          { address: '0xb3', percent: '10' },
          { address: '0xb4', percent: '5' }, // 4 件目は切捨
        ],
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.splits).toHaveLength(3);
    expect(result.current.settings.splits[0]).toEqual({
      address: '0xb1',
      percent: '30',
    });
  });

  it('splits が不正形式 → 空配列', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ splits: 'not-an-array' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.splits).toEqual([]);
  });

  it('破損 JSON → defaults', async () => {
    window.localStorage.setItem(KEY, '{not-json');
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('usdc');
    expect(result.current.settings.splits).toEqual([]);
  });

  it('部分的に不正な値 → default で埋める (token 不正)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'btc', receiver: '0xa' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('usdc');
    expect(result.current.settings.receiver).toBe('0xa');
  });

  it('setSettings で splits を含めて更新 → localStorage 書込', async () => {
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.setSettings({
        receiver: '0xdef',
        token: 'jpyc',
        directTransfer: true,
        splits: [{ address: '0xb1', percent: '40' }],
      });
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.token).toBe('jpyc');
      expect(parsed.receiver).toBe('0xdef');
      expect(parsed.directTransfer).toBe(true);
      expect(parsed.splits).toEqual([{ address: '0xb1', percent: '40' }]);
    });
  });

  it('hydrate 完了前は localStorage に書込まない (上書き防止)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ receiver: '0xkeep', token: 'jpyc', fee: 'exclude' }),
    );
    renderHook(() => useQrSettings());
    const initial = window.localStorage.getItem(KEY);
    expect(initial).toContain('0xkeep');
  });
});
