import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTipSettings } from '@/hooks/useTipSettings';

const KEY = 'openpay:tip-settings:v2';

describe('useTipSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存時は defaults', async () => {
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '',
      token: 'jpyc',
      name: '',
      message: '',
      color: '#2563eb',
      presets: '',
      thanks: '',
      thanksUrl: '',
      webhook: '',
    });
  });

  it('破損 JSON → defaults', async () => {
    window.localStorage.setItem(KEY, '{not-json');
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('jpyc');
  });

  it('保存値からハイドレート (旧スキーマでも欠損は default 補完)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'usdc',
        name: 'Alice',
        message: 'hi',
        color: '#ff00ff',
        presets: '1,5',
      }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '0xabc',
      token: 'usdc',
      name: 'Alice',
      message: 'hi',
      color: '#ff00ff',
      presets: '1,5',
      thanks: '',
      thanksUrl: '',
      webhook: '',
    });
  });

  it('color が #rrggbb でない値 → default に置換', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ color: 'red', token: 'jpyc' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.color).toBe('#2563eb');
  });

  it('color の大文字を小文字化', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ color: '#ABCDEF', token: 'jpyc' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.color).toBe('#abcdef');
  });

  it('token が unsupported → default jpyc に置換', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'btc' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('jpyc');
  });

  it('setSettings → localStorage 書込 (thanks/thanksUrl/webhook 含む)', async () => {
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.setSettings({
        receiver: '0xdef',
        token: 'usdc',
        name: 'Bob',
        message: 'thx',
        color: '#112233',
        presets: '2,4,8',
        thanks: 'ありがとう',
        thanksUrl: 'https://example.com',
        webhook: 'https://example.com/hook',
      });
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed).toEqual({
        receiver: '0xdef',
        token: 'usdc',
        name: 'Bob',
        message: 'thx',
        color: '#112233',
        presets: '2,4,8',
        thanks: 'ありがとう',
        thanksUrl: 'https://example.com',
        webhook: 'https://example.com/hook',
      });
    });
  });

  it('hydrate 完了前に localStorage を上書きしない', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ receiver: '0xkeep', token: 'jpyc' }),
    );
    renderHook(() => useTipSettings());
    const initial = window.localStorage.getItem(KEY);
    expect(initial).toContain('0xkeep');
  });
});
