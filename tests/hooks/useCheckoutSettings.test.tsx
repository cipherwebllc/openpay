import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCheckoutSettings } from '@/hooks/useCheckoutSettings';

const KEY = 'openpay:checkout-settings:v1';

describe('useCheckoutSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存時は defaults (token=jpyc, chain=polygon, items 1 行 — JPYC をメインに)', async () => {
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '',
      token: 'jpyc',
      chain: 'polygon',
      gasMode: 'customer',
      payMode: 'gasless',
      items: [{ name: '', qty: '', price: '' }],
      orderId: '',
      description: '',
      customerEmail: '',
      successUrl: '',
      cancelUrl: '',
      webhook: '',
    });
  });

  it('破損 JSON → defaults', async () => {
    window.localStorage.setItem(KEY, '{not-json');
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('jpyc');
  });

  it('保存値からハイドレート (旧スキーマ風で欠損は default 補完)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'jpyc',
        items: [{ name: 'A', qty: '1', price: '100' }],
        orderId: 'ord-1',
      }),
    );
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.receiver).toBe('0xabc');
    expect(result.current.settings.token).toBe('jpyc');
    expect(result.current.settings.chain).toBe('polygon'); // jpyc → polygon 強制
    expect(result.current.settings.items).toEqual([
      { name: 'A', qty: '1', price: '100' },
    ]);
    expect(result.current.settings.orderId).toBe('ord-1');
  });

  it('jpyc + 不正 chain (arbitrum) → polygon に強制', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', chain: 'arbitrum' }),
    );
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('polygon');
  });

  it('usdc + 有効 chain (optimism) → そのまま保存', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'optimism' }),
    );
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('optimism');
  });

  it('usdc + 不正 chain (unknownchain) → default base に倒す', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'unknownchain' }),
    );
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('base');
  });

  it('items が配列でない → default の 1 行に倒す', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ items: 'broken' }));
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.items).toEqual([
      { name: '', qty: '', price: '' },
    ]);
  });

  it('items が 11 件以上 → 10 件で切詰', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      name: `I${i}`,
      qty: '1',
      price: '1',
    }));
    window.localStorage.setItem(KEY, JSON.stringify({ items }));
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.items).toHaveLength(10);
  });

  it('orderId / description / email が長すぎる → 切詰', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        orderId: 'a'.repeat(100),
        description: 'b'.repeat(300),
        customerEmail: 'c'.repeat(300),
      }),
    );
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.orderId.length).toBe(64);
    expect(result.current.settings.description.length).toBe(200);
    expect(result.current.settings.customerEmail.length).toBe(240);
  });

  it('setSettings → localStorage に書込まれる', async () => {
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => {
      result.current.setSettings({
        ...result.current.settings,
        receiver: '0xdef',
        items: [{ name: 'X', qty: '5', price: '12.34' }],
        orderId: 'ord-99',
      });
    });
    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.receiver).toBe('0xdef');
      expect(parsed.items).toEqual([{ name: 'X', qty: '5', price: '12.34' }]);
      expect(parsed.orderId).toBe('ord-99');
    });
  });

  it('hydrate 完了前は localStorage を上書きしない', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ receiver: '0xkeep', token: 'usdc' }),
    );
    renderHook(() => useCheckoutSettings());
    const initial = window.localStorage.getItem(KEY);
    expect(initial).toContain('0xkeep');
  });

  it('gasMode 不正値 → customer (default)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', gasMode: 'free' }),
    );
    const { result } = renderHook(() => useCheckoutSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.gasMode).toBe('customer');
  });
});
