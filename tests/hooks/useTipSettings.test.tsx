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
      receiverSource: 'manual',
      token: 'jpyc',
      chain: 'polygon',
      name: '',
      message: '',
      color: '#2563eb',
      theme: 'clean',
      presets: { jpyc: ['300', '1000', '3000'], usdc: ['5', '20', '50'] },
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
      receiverSource: 'manual',
      token: 'usdc',
      chain: 'base',
      name: 'Alice',
      message: 'hi',
      color: '#ff00ff',
      theme: 'clean',
      // 旧 CSV '1,5' は最後の token (usdc) のリストへ migrate、jpyc は既定。
      presets: { jpyc: ['300', '1000', '3000'], usdc: ['1', '5'] },
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

  it('theme は allowlist のみ復元し、旧保存値/不正値は clean に倒す', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', theme: 'night' }),
    );
    const themed = renderHook(() => useTipSettings());
    await waitFor(() => expect(themed.result.current.hydrated).toBe(true));
    expect(themed.result.current.settings.theme).toBe('night');
    themed.unmount();

    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', theme: 'neon' }),
    );
    const invalid = renderHook(() => useTipSettings());
    await waitFor(() => expect(invalid.result.current.hydrated).toBe(true));
    expect(invalid.result.current.settings.theme).toBe('clean');
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

    const presets = { jpyc: ['300', '1000', '3000'], usdc: ['2', '4', '8'] };
    act(() => {
      result.current.setSettings({
        receiver: '0xdef',
        receiverSource: 'manual',
        token: 'usdc',
        chain: 'optimism',
        name: 'Bob',
        message: 'thx',
        color: '#112233',
        presets,
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
        receiverSource: 'manual',
        token: 'usdc',
        chain: 'optimism',
        name: 'Bob',
        message: 'thx',
        color: '#112233',
        presets,
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

  it('presets が token 別 object でも CSV でもない形 (数値 array) → token 別既定', async () => {
    // [100,500] は object 扱いだが o.jpyc/o.usdc 不在 → 両 token 既定に倒す。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', presets: [100, 500] }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets).toEqual({
      jpyc: ['300', '1000', '3000'],
      usdc: ['5', '20', '50'],
    });
  });

  it('旧 CSV + token=usdc → USDC へ migrate、JPYC は既定 (USDC カスタム値を失わない)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'base', presets: '8,15' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets).toEqual({
      jpyc: ['300', '1000', '3000'],
      usdc: ['8', '15'],
    });
  });

  it('旧 CSV は strict 検証 (2000yen / -5 / abc は補正せず除外、有効値のみ)', async () => {
    // QR の lenient sanitizer なら 2000yen→2000・-5→5 になるが、Tip は strict。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', presets: '2000yen,-5,abc,,300,1000' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets.jpyc).toEqual(['300', '1000']);
    expect(result.current.settings.presets.usdc).toEqual(['5', '20', '50']);
  });

  it('旧 CSV が空 → 両 token 既定に倒す', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', presets: '' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets).toEqual({
      jpyc: ['300', '1000', '3000'],
      usdc: ['5', '20', '50'],
    });
  });

  it('新 object schema は token ごと独立に保持、片方空は既定に倒す', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        presets: { jpyc: ['100', '250'], usdc: [] },
      }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets).toEqual({
      jpyc: ['100', '250'],
      usdc: ['5', '20', '50'],
    });
  });

  it('presets は最大 6 件で truncate (旧 CSV)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', presets: '1,2,3,4,5,6,7,8' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets.jpyc).toEqual([
      '1', '2', '3', '4', '5', '6',
    ]);
  });

  it('新 object schema: 不正 / 0 / 負 / 重複 entry を strict に除外', async () => {
    // object 分岐も CSV 分岐と同じ strict 検証 (lenient stripping しない)。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        presets: {
          jpyc: ['abc', '100', '100', '0', '-5', '2000yen', '200'],
          usdc: ['7'],
        },
      }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets.jpyc).toEqual(['100', '200']);
    expect(result.current.settings.presets.usdc).toEqual(['7']);
  });

  it('新 object schema: token 内で最大 6 件に truncate', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        presets: { jpyc: ['1', '2', '3', '4', '5', '6', '7', '8'], usdc: ['5'] },
      }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.presets.jpyc).toEqual([
      '1', '2', '3', '4', '5', '6',
    ]);
    expect(result.current.settings.presets.usdc).toEqual(['5']);
  });

  it('新 object schema: 非配列の token 値 (string/number) は既定に倒す', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        presets: { jpyc: '100,200', usdc: 42 },
      }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    // sanitizeTipPresetList は非配列 → [] → token 別既定へ fallback
    expect(result.current.settings.presets).toEqual({
      jpyc: ['300', '1000', '3000'],
      usdc: ['5', '20', '50'],
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

  it('usdc + ethereum → そのまま保存される (2026-05 から L1 も gasless 対応)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'ethereum' }),
    );
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('ethereum');
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

  it('jpyc + kaia + crossChain=false 保存 → 再 mount で完全復元', async () => {
    const persisted = {
      receiver: '0xabc',
      receiverSource: 'manual' as const,
      token: 'jpyc' as const,
      chain: 'kaia' as const,
      name: 'Test',
      message: 'msg',
      color: '#abcdef',
      presets: { jpyc: ['100', '500'], usdc: ['5', '20', '50'] },
      thanks: 'thx',
      thanksUrl: '',
      webhook: '',
      crossChain: false,
    };
    window.localStorage.setItem(KEY, JSON.stringify(persisted));
    const { result } = renderHook(() => useTipSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({ ...persisted, theme: 'clean' });
  });

  it('setSettings → localStorage 書込 → 新 instance の hydration で復元 (remount 永続化)', async () => {
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
