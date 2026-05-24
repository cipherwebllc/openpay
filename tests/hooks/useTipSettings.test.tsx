import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTipSettings } from '@/hooks/useTipSettings';

const KEY = 'openpay:tip-settings:v2';

describe('useTipSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存時は defaults (token=jpyc, chain=polygon)', async () => {
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '',
      token: 'jpyc',
      chain: 'polygon',
      name: '',
      message: '',
      color: '#2563eb',
      presets: '',
      thanks: '',
      thanksUrl: '',
      webhook: '',
      crossChain: true,
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
      chain: 'base',
      name: 'Alice',
      message: 'hi',
      color: '#ff00ff',
      presets: '1,5',
      thanks: '',
      thanksUrl: '',
      webhook: '',
      crossChain: true,
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
        chain: 'optimism',
        name: 'Bob',
        message: 'thx',
        color: '#112233',
        presets: '2,4,8',
        thanks: 'ありがとう',
        thanksUrl: 'https://example.com',
        webhook: 'https://example.com/hook',
        crossChain: true,
      });
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed).toEqual({
        receiver: '0xdef',
        token: 'usdc',
        chain: 'optimism',
        name: 'Bob',
        message: 'thx',
        color: '#112233',
        presets: '2,4,8',
        thanks: 'ありがとう',
        thanksUrl: 'https://example.com',
        webhook: 'https://example.com/hook',
        crossChain: true,
      });
    });
  });

  it('jpyc + 不正 chain → polygon に強制', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', chain: 'arbitrum' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('polygon');
  });

  it('usdc + 有効 chain (arbitrum) → そのまま保存', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'arbitrum' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('arbitrum');
  });

  it('thanks / thanksUrl / webhook を string として保存 → そのまま hydrate', async () => {
    // sanitize の string 分岐 (L62-63, L66-67, L70-71) を踏むため、localStorage に
    // 直接 string を仕込んでから renderHook で load → sanitize 経由で復元される。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        thanks: '本日もありがとうございました',
        thanksUrl: 'https://shop.example.com/thanks',
        webhook: 'https://discord.com/api/webhooks/abc',
      }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.thanks).toBe(
      '本日もありがとうございました',
    );
    expect(result.current.settings.thanksUrl).toBe(
      'https://shop.example.com/thanks',
    );
    expect(result.current.settings.webhook).toBe(
      'https://discord.com/api/webhooks/abc',
    );
  });

  it('thanks / thanksUrl / webhook が非文字列 (number / null) → defaults に置換', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        thanks: 42,
        thanksUrl: null,
        webhook: { url: 'evil' },
      }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.thanks).toBe('');
    expect(result.current.settings.thanksUrl).toBe('');
    expect(result.current.settings.webhook).toBe('');
  });

  it('presets が非文字列 (array) → default の空文字列に置換', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', presets: [100, 500] }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets).toBe('');
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

  it('crossChain 未保存 → default true (旧 schema 救済)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'base' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.crossChain).toBe(true);
  });

  it('crossChain: false を明示保存 → false で復元', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'base', crossChain: false }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.crossChain).toBe(false);
  });

  it('crossChain が文字列など boolean 以外 → default true に倒す', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'base', crossChain: 'false' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.crossChain).toBe(true);
  });

  it('jpyc + kaia chain → そのまま保存 (Kaia tip 対応)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', chain: 'kaia' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('kaia');
  });
});
