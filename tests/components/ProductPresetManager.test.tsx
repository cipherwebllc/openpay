import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { ProductPresetManager } from '@/components/ProductPresetManager';
import type { ProductPreset } from '@/hooks/useProductPresets';

function preset(over: Partial<ProductPreset> = {}): ProductPreset {
  return {
    id: 'p1',
    name: 'コーヒー',
    unitPrice: '500',
    token: 'jpyc',
    taxRate: 10,
    taxCategory: 'taxable_10',
    memo: null,
    sortOrder: 0,
    enabled: true,
    ...over,
  };
}

function setup(presets: ProductPreset[]) {
  const fns = {
    addPreset: vi.fn(),
    updatePreset: vi.fn(),
    removePreset: vi.fn(),
    movePreset: vi.fn(),
  };
  render(<ProductPresetManager presets={presets} {...fns} />);
  return fns;
}

describe('ProductPresetManager', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('プリセット一覧を表示する', () => {
    setup([preset({ id: 'a', name: 'コーヒー' }), preset({ id: 'b', name: 'Tシャツ', unitPrice: '3000' })]);
    expect(screen.getByDisplayValue('コーヒー')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Tシャツ')).toBeInTheDocument();
  });

  it('名前編集で updatePreset を呼ぶ', () => {
    const fns = setup([preset({ id: 'a', name: 'コーヒー' })]);
    fireEvent.change(screen.getByDisplayValue('コーヒー'), {
      target: { value: 'カフェラテ' },
    });
    expect(fns.updatePreset).toHaveBeenCalledWith('a', { name: 'カフェラテ' });
  });

  it('表示チェックボックスで enabled を更新', () => {
    const fns = setup([preset({ id: 'a', enabled: true })]);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(fns.updatePreset).toHaveBeenCalledWith('a', { enabled: false });
  });

  it('削除ボタン (確認 OK) で removePreset を呼ぶ', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    const fns = setup([preset({ id: 'a' })]);
    await user.click(screen.getByLabelText('削除'));
    expect(fns.removePreset).toHaveBeenCalledWith('a');
  });

  it('削除ボタン (確認キャンセル) では呼ばない', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    const fns = setup([preset({ id: 'a' })]);
    await user.click(screen.getByLabelText('削除'));
    expect(fns.removePreset).not.toHaveBeenCalled();
  });

  it('下へボタンで movePreset を呼ぶ', async () => {
    const user = userEvent.setup();
    const fns = setup([preset({ id: 'a' }), preset({ id: 'b', name: 'Tシャツ' })]);
    // 先頭行の「下へ」
    await user.click(screen.getAllByLabelText('下へ')[0]);
    expect(fns.movePreset).toHaveBeenCalledWith('a', 'down');
  });

  it('追加フォーム: 名前 + 単価入力 → 追加で addPreset を呼ぶ', async () => {
    const user = userEvent.setup();
    const fns = setup([]);
    await user.type(screen.getByPlaceholderText('例: コーヒー'), 'ステッカー');
    await user.type(screen.getByPlaceholderText('500'), '200');
    await user.click(screen.getByRole('button', { name: '追加' }));
    expect(fns.addPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ステッカー',
        unitPrice: '200',
        token: 'jpyc',
        taxCategory: 'taxable_10',
        taxRate: 10,
        enabled: true,
      }),
    );
  });

  it('プリセットが空のとき empty メッセージを表示', () => {
    setup([]);
    expect(
      screen.getByText('プリセットがありません。下のフォームから追加できます。'),
    ).toBeInTheDocument();
  });
});
