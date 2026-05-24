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

  // === crossChain sanitize 境界 ===
  it.each([
    ['null', null],
    ['number 0', 0],
    ['number 1', 1],
    ['empty string', ''],
    ['object', { x: 1 }],
    ['array', [true]],
  ])('crossChain が %s → default true に倒す', async (_label, raw) => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'base', crossChain: raw }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.crossChain).toBe(true);
  });

  // === token + chain 整合性 (gasless 必須 fallback) ===
  it('usdc + ethereum (gasless 非対応) → token default (base) に fallback', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'ethereum' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('base');
  });

  it('jpyc + base (JPYC 非 deploy) → polygon に fallback', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', chain: 'base' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('polygon');
  });

  // === 永続化 roundtrip (Kaia + crossChain=false の combo) ===
  it('jpyc + kaia + crossChain=false 保存 → 再 mount で完全復元', async () => {
    const persisted = {
      receiver: '0xabc',
      token: 'jpyc' as const,
      chain: 'kaia' as const,
      name: 'Test',
      message: 'msg',
      color: '#abcdef',
      presets: '100,500',
      thanks: 'thx',
      thanksUrl: '',
      webhook: '',
      crossChain: false,
    };
    window.localStorage.setItem(KEY, JSON.stringify(persisted));
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual(persisted);
  });

  it('setSettings → localStorage 書込 → 別 hook instance が復元 (cross-component sync の前提)', async () => {
    const { result: writer } = renderHook(() => useTipSettings());
    await waitFor(() => expect(writer.current.hydrated).toBe(true));
    act(() => {
      writer.current.setSettings((s) => ({
        ...s,
        token: 'usdc',
        chain: 'arbitrum',
        crossChain: false,
      }));
    });
    await waitFor(() => {
      const raw = window.localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.crossChain).toBe(false);
      expect(parsed.chain).toBe('arbitrum');
    });

    // 別 hook instance で同 storage を read → 同 state に復元
    const { result: reader } = renderHook(() => useTipSettings());
    await waitFor(() => expect(reader.current.hydrated).toBe(true));
    expect(reader.current.settings.token).toBe('usdc');
    expect(reader.current.settings.chain).toBe('arbitrum');
    expect(reader.current.settings.crossChain).toBe(false);
  });
});
