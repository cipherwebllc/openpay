import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

// Phase 1 flag (おすすめチェックボックスのゲート)。既定 OFF=非表示。
const envHold = vi.hoisted(() => ({ enableShopLive: false, enableMenuOptions: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableShopLive() {
        return envHold.enableShopLive;
      },
      get enableMenuOptions() {
        return envHold.enableMenuOptions;
      },
    },
  };
});

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
  beforeEach(() => {
    vi.restoreAllMocks();
    envHold.enableShopLive = false; // 既定 OFF (おすすめチェックボックス非表示)
    envHold.enableMenuOptions = false; // 既定 OFF (オプション編集非表示)
  });

  it('プリセット一覧を表示する', () => {
    setup([preset({ id: 'a', name: 'コーヒー' }), preset({ id: 'b', name: 'Tシャツ', unitPrice: '3000' })]);
    expect(screen.getByDisplayValue('コーヒー')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Tシャツ')).toBeInTheDocument();
  });

  it('商品サムネ: no-referrer・lazy・失敗時は同寸の装飾枠・URL を直すと再試行 (R7a の網・B-R7)', () => {
    const fns = { addPreset: vi.fn(), updatePreset: vi.fn(), removePreset: vi.fn(), movePreset: vi.fn() };
    const { rerender } = render(
      <ProductPresetManager presets={[preset({ image: 'https://images.example/preset.png' })]} {...fns} />,
    );
    const image = document.querySelector('img')!;
    // B-R7: レジ設定画面の URL を Referer として画像ホストへ送らない・一覧は遅延・decode は非同期。
    expect(image.outerHTML).toBe('<img alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" class="h-8 w-8 shrink-0 rounded object-cover" src="https://images.example/preset.png">');
    const parent = image.parentElement!;
    const input = parent.querySelector('input')!;
    fireEvent.error(image);
    // 壊れ画像 icon を出さず、同寸の装飾枠に置き換える (枠ごと消すと入力中に入力欄が左右に跳ねる)。
    expect(document.querySelector('img')).toBeNull();
    const placeholder = parent.firstElementChild!;
    expect(placeholder.outerHTML).toBe('<span aria-hidden="true" class="h-8 w-8 shrink-0 rounded bg-slate-100"></span>');
    // 画像と同じ箱 (幅・高さ・shrink・角丸) を持つ。
    expect(placeholder).toHaveClass(...'h-8 w-8 shrink-0 rounded object-cover'.split(' ').filter((c) => c !== 'object-cover'));
    expect(placeholder.nextElementSibling).toBe(input);
    rerender(<ProductPresetManager presets={[preset({ image: 'https://images.example/preset2.png' })]} {...fns} />);
    expect(document.querySelector('img')).toHaveAttribute('src', 'https://images.example/preset2.png');
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
    fireEvent.click(screen.getByLabelText('表示'));
    expect(fns.updatePreset).toHaveBeenCalledWith('a', { enabled: false });
  });

  it('おすすめチェックボックスで recommended を更新 (true のみ保持)', () => {
    envHold.enableShopLive = true; // おすすめチェックボックスは Phase 1 flag 裏
    const fns = setup([preset({ id: 'a' })]);
    fireEvent.click(screen.getByLabelText('おすすめ'));
    expect(fns.updatePreset).toHaveBeenCalledWith('a', { recommended: true });
  });

  it('shopLive props があると可視ラベル付き売り切れトグルを表示して更新する', () => {
    const toggleSoldOut = vi.fn();
    const fns = {
      addPreset: vi.fn(),
      updatePreset: vi.fn(),
      removePreset: vi.fn(),
      movePreset: vi.fn(),
    };
    render(
      <ProductPresetManager
        presets={[preset({ id: 'a' })]}
        {...fns}
        shopLive={{
          state: { soldOut: ['a'], paused: false, updatedAt: 1 },
          toggleSoldOut,
          isPending: false,
        }}
      />,
    );
    const toggle = screen.getByRole('checkbox', { name: '売り切れ' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggleSoldOut).toHaveBeenCalledWith('a', false);
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

  it('カテゴリー編集で updatePreset を呼ぶ', () => {
    const fns = setup([preset({ id: 'a' })]);
    // 行内カテゴリー入力 (add フォームより前に出る) を編集。
    const catInputs = screen.getAllByPlaceholderText('例: ドリンク');
    fireEvent.change(catInputs[0], { target: { value: 'ドリンク' } });
    expect(fns.updatePreset).toHaveBeenCalledWith('a', { category: 'ドリンク' });
  });

  it('追加フォーム: カテゴリーも addPreset に渡す', async () => {
    const user = userEvent.setup();
    const fns = setup([]); // 空 → カテゴリー入力は add フォームの 1 つだけ
    await user.type(screen.getByPlaceholderText('例: コーヒー'), 'カフェラテ');
    await user.type(screen.getByPlaceholderText('500'), '600');
    await user.type(screen.getByPlaceholderText('例: ドリンク'), 'ドリンク');
    await user.click(screen.getByRole('button', { name: '追加' }));
    expect(fns.addPreset).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'ドリンク' }),
    );
  });

  it('プリセットが空のとき empty メッセージを表示', () => {
    setup([]);
    expect(
      screen.getByText('プリセットがありません。下のフォームから追加できます。'),
    ).toBeInTheDocument();
  });

  it('オプション編集: flag ON で表示・「オプションを追加」で updatePreset(options)', () => {
    envHold.enableMenuOptions = true;
    const fns = setup([preset({ id: 'a' })]);
    expect(screen.getByText('オプション（サイズ/トッピング）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'オプションを追加' }));
    expect(fns.updatePreset).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ options: expect.any(Array) }),
    );
  });

  it('オプション編集: flag OFF では非表示', () => {
    setup([preset({ id: 'a' })]);
    expect(screen.queryByText('オプション（サイズ/トッピング）')).toBeNull();
  });
});
