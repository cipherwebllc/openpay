import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQrSettings } from '@/hooks/useQrSettings';

const KEY = 'openpay:qr-settings:v2';

describe('useQrSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存時は defaults (token=usdc, chain=base)', async () => {
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '',
      token: 'usdc',
      chain: 'base',
      gasMode: 'customer',
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
    expect(result.current.settings.chain).toBe('polygon');
    expect(result.current.settings.receiver).toBe('0xabc');
    expect(result.current.settings.directTransfer).toBe(false);
    expect(result.current.settings.splits).toEqual([]);
  });

  it('jpyc + 不正 chain (arbitrum) → polygon に強制', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', chain: 'arbitrum' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('polygon');
  });

  it('usdc + 不正 chain → default base に倒す', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'avalanche' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('base');
  });

  it('usdc + arbitrum (有効) → そのまま保存される', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'arbitrum' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('arbitrum');
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
        chain: 'polygon',
        gasMode: 'merchant',
        directTransfer: true,
        splits: [{ address: '0xb1', percent: '40' }],
      });
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.token).toBe('jpyc');
      expect(parsed.chain).toBe('polygon');
      expect(parsed.gasMode).toBe('merchant');
      expect(parsed.receiver).toBe('0xdef');
      expect(parsed.directTransfer).toBe(true);
      expect(parsed.splits).toEqual([{ address: '0xb1', percent: '40' }]);
    });
  });

  it('gasMode が不正値 → exclude (default) で復元', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', gasMode: 'free', receiver: '0xa' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.gasMode).toBe('customer');
  });

  it('gasMode=merchant を保存できる', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', gasMode: 'merchant', receiver: '0xa' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.gasMode).toBe('merchant');
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
