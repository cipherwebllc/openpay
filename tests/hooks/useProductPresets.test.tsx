import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProductPresets } from '@/hooks/useProductPresets';

const STORAGE_KEY = 'openpay:product-presets:v1';

beforeEach(() => {
  window.localStorage.clear();
});

describe('useProductPresets', () => {
  it('初回は初期サンプルを seed する (4 件・コーヒー/Tシャツ/イベント参加費/Tip)', () => {
    const { result } = renderHook(() => useProductPresets());
    expect(result.current.hydrated).toBe(true);
    const names = result.current.presets.map((p) => p.name);
    expect(names).toEqual(['コーヒー', 'Tシャツ', 'イベント参加費', 'Tip']);
    // Tip は対象外 (税率 0)
    const tip = result.current.presets.find((p) => p.name === 'Tip');
    expect(tip?.taxCategory).toBe('out_of_scope');
    expect(tip?.taxRate).toBe(0);
  });

  it('addPreset で追加され LocalStorage に永続する', () => {
    const { result } = renderHook(() => useProductPresets());
    act(() => {
      result.current.addPreset({
        name: 'ステッカー',
        unitPrice: '200',
        token: 'jpyc',
        taxRate: 10,
        taxCategory: 'taxable_10',
        memo: null,
        enabled: true,
      });
    });
    expect(result.current.presets.map((p) => p.name)).toContain('ステッカー');
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.presets.some((p: { name: string }) => p.name === 'ステッカー')).toBe(
      true,
    );
  });

  it('updatePreset で編集 / removePreset で削除', () => {
    const { result } = renderHook(() => useProductPresets());
    const id = result.current.presets[0].id;
    act(() => result.current.updatePreset(id, { unitPrice: '550' }));
    expect(result.current.presets[0].unitPrice).toBe('550');
    act(() => result.current.removePreset(id));
    expect(result.current.presets.find((p) => p.id === id)).toBeUndefined();
    expect(result.current.presets).toHaveLength(3);
  });

  it('image は https のみ採用・非 https は drop (addPreset + 再 load sanitize)', () => {
    const { result, unmount } = renderHook(() => useProductPresets());
    act(() => {
      result.current.addPreset({
        name: '画像あり',
        unitPrice: '500',
        token: 'jpyc',
        taxRate: 10,
        taxCategory: 'taxable_10',
        memo: null,
        enabled: true,
        image: 'https://img.example/a.png',
      });
      result.current.addPreset({
        name: '不正画像',
        unitPrice: '500',
        token: 'jpyc',
        taxRate: 10,
        taxCategory: 'taxable_10',
        memo: null,
        enabled: true,
        image: 'javascript:alert(1)',
      });
    });
    expect(result.current.presets.find((p) => p.name === '画像あり')?.image).toBe(
      'https://img.example/a.png',
    );
    expect(result.current.presets.find((p) => p.name === '不正画像')?.image).toBeUndefined();
    unmount();
    // 再 load 時の sanitize でも https のみ残る。
    const second = renderHook(() => useProductPresets());
    expect(second.result.current.presets.find((p) => p.name === '画像あり')?.image).toBe(
      'https://img.example/a.png',
    );
  });

  it('全削除後の再マウントで seed は復活しない (削除を尊重)', () => {
    const first = renderHook(() => useProductPresets());
    act(() => {
      for (const p of [...first.result.current.presets]) {
        first.result.current.removePreset(p.id);
      }
    });
    expect(first.result.current.presets).toHaveLength(0);
    first.unmount();
    // 別インスタンスで再 load → 空配列が尊重され seed が戻らない
    const second = renderHook(() => useProductPresets());
    expect(second.result.current.presets).toHaveLength(0);
  });

  it('movePreset で表示順を入れ替える', () => {
    const { result } = renderHook(() => useProductPresets());
    const before = result.current.presets.map((p) => p.name);
    act(() => result.current.movePreset(result.current.presets[1].id, 'up'));
    const after = result.current.presets.map((p) => p.name);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
    // sortOrder は index ミラー
    expect(result.current.presets.map((p) => p.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('enabledPresets は enabled のみ', () => {
    const { result } = renderHook(() => useProductPresets());
    const id = result.current.presets[0].id;
    act(() => result.current.updatePreset(id, { enabled: false }));
    expect(result.current.enabledPresets.find((p) => p.id === id)).toBeUndefined();
    expect(result.current.enabledPresets).toHaveLength(3);
  });

  it('nextReceiptNo は日次連番 (R-YYYYMMDD-NNN)', () => {
    const { result } = renderHook(() => useProductPresets());
    let r1 = '';
    let r2 = '';
    act(() => {
      r1 = result.current.nextReceiptNo();
    });
    act(() => {
      r2 = result.current.nextReceiptNo();
    });
    expect(r1).toMatch(/^R-\d{8}-001$/);
    expect(r2).toMatch(/^R-\d{8}-002$/);
  });

  it('addPreset: 単価は decimal 以外を除去・name 空は無視されない (cap)', () => {
    const { result } = renderHook(() => useProductPresets());
    act(() => {
      result.current.addPreset({
        name: 'X'.repeat(200),
        unitPrice: '¥1,200',
        token: 'jpyc',
        taxRate: 10,
        taxCategory: 'taxable_10',
        memo: null,
        enabled: true,
      });
    });
    const added = result.current.presets[result.current.presets.length - 1];
    expect(added.name.length).toBe(80);
    expect(added.unitPrice).toBe('1200'); // ¥ と , を除去 → "1200"
  });
});
