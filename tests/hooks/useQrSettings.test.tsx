import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQrSettings } from '@/hooks/useQrSettings';

const KEY = 'openpay:qr-settings:v2';

describe('useQrSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('未保存時は defaults (token=jpyc, chain=polygon — JPYC をメインに)', async () => {
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings).toEqual({
      receiver: '',
      token: 'jpyc',
      chain: 'polygon',
      gasMode: 'customer',
      payMode: 'gasless',
      splits: [],
      storeName: '',
      posterNote: '',
      quickAmounts: ['500', '1000', '1500', '3000'],
    });
  });

  it('保存値からハイドレート (旧スキーマ: payMode/splits なし → default 補完)', async () => {
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
    expect(result.current.settings.payMode).toBe('gasless');
    expect(result.current.settings.splits).toEqual([]);
    expect(result.current.settings.storeName).toBe('');
    expect(result.current.settings.posterNote).toBe('');
    expect(result.current.settings.quickAmounts).toEqual([
      '500',
      '1000',
      '1500',
      '3000',
    ]);
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

  it('jpyc + kaia (PoC、2026-05) → そのまま保存される (JpycChainSlug で許容)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'jpyc', chain: 'kaia' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('kaia');
    expect(result.current.settings.token).toBe('jpyc');
  });

  it('usdc + kaia (kaia には Circle native USDC なし) → base に fallback', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'usdc', chain: 'kaia' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.chain).toBe('base');
  });

  it('payMode=standard の保存値をハイドレート', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'usdc',
        payMode: 'standard',
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.payMode).toBe('standard');
  });

  it('legacy migration: directTransfer=true (旧 schema) は payMode=standard に変換される', async () => {
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
    expect(result.current.settings.payMode).toBe('standard');
  });

  it('legacy migration: directTransfer=false (旧 schema) は payMode=gasless に変換される', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'usdc',
        directTransfer: false,
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.payMode).toBe('gasless');
  });

  it('splits 配列をハイドレート (最大 3 件まで)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        receiver: '0xabc',
        token: 'usdc',
        payMode: 'gasless',
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
    expect(result.current.settings.token).toBe('jpyc');
    expect(result.current.settings.splits).toEqual([]);
  });

  it('部分的に不正な値 → default で埋める (token 不正)', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'btc', receiver: '0xa' }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.token).toBe('jpyc');
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
        payMode: 'standard',
        splits: [{ address: '0xb1', percent: '40' }],
        storeName: 'Coffee Stand',
        posterNote: 'Scan to pay',
        quickAmounts: ['300', '750', '1200'],
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
      expect(parsed.payMode).toBe('standard');
      expect(parsed.splits).toEqual([{ address: '0xb1', percent: '40' }]);
      expect(parsed.storeName).toBe('Coffee Stand');
      expect(parsed.posterNote).toBe('Scan to pay');
      expect(parsed.quickAmounts).toEqual(['300', '750', '1200']);
    });
  });

  it('店舗向け設定を sanitize する', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        storeName: `  ${'A'.repeat(60)}\u0000  `,
        posterNote: `  ${'B'.repeat(120)}\u0007  `,
        quickAmounts: [
          '500',
          'abc',
          '500',
          '0',
          '1000.50',
          '2000yen',
          '3000',
          '4000',
          '5000',
          '6000',
          '7000',
          '8000',
          '9000',
        ],
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.storeName).toBe('A'.repeat(48));
    expect(result.current.settings.posterNote).toBe('B'.repeat(96));
    expect(result.current.settings.quickAmounts).toEqual([
      '500',
      '1000.50',
      '2000',
      '3000',
      '4000',
      '5000',
      '6000',
      '7000',
    ]);
  });

  it('quickAmounts に混在型 (number / null / object) → string のみ残す', async () => {
    // localStorage は string でしか保存できないが、外部スクリプトに改変された
    // ケースや schema 変更で型が崩れた場合に備えて、非 string entry は dropping。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        quickAmounts: [
          500,
          null,
          { amount: '100' },
          ['1000'],
          '300',
          undefined,
          '600',
        ],
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    // string entry のうち valid なものだけ ('300', '600')
    expect(result.current.settings.quickAmounts).toEqual(['300', '600']);
  });

  it('quickAmounts が all-invalid → DEFAULT_SETTINGS.quickAmounts へ fallback', async () => {
    // 注: '-1' は記号除去後 '1' になり valid 扱い (運営意図: 記号が紛れた誤入力を救済)。
    // 「全 invalid」を成立させるには 0、空、文字のみ、数字 0 件のものを並べる。
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        quickAmounts: ['', '0', 'abc', null, 'NaN', '0.0'],
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    // 1 件も valid が無い → defaults (500/1000/1500/3000) で復元
    expect(result.current.settings.quickAmounts).toEqual([
      '500',
      '1000',
      '1500',
      '3000',
    ]);
  });

  it('quickAmounts が QUICK_AMOUNT_MAX (8) を超えると 8 件で truncate', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        quickAmounts: [
          '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
        ],
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.quickAmounts).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8',
    ]);
  });

  it('storeName / posterNote: max 桁ちょうど (48 / 96) は切らずに保存', async () => {
    // 境界条件: 上限ちょうど = 切られない、+1 = 切られる
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        storeName: 'A'.repeat(48),
        posterNote: 'B'.repeat(96),
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.storeName).toBe('A'.repeat(48));
    expect(result.current.settings.posterNote).toBe('B'.repeat(96));
  });

  it('storeName / posterNote が非文字列 (number / object) → 空文字列', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        token: 'jpyc',
        storeName: 12345,
        posterNote: { v: 'x' },
      }),
    );
    const { result } = renderHook(() => useQrSettings());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.settings.storeName).toBe('');
    expect(result.current.settings.posterNote).toBe('');
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
