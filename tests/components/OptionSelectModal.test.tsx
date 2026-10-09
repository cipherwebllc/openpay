// OptionSelectModal の focus 管理 (D1): aria-modal を名乗るので、開いたら dialog へ focus・Tab は中だけを回る
// (ラジオは名前ごとに 1 つの Tab 停止 = ブラウザ標準と同じ)・Escape で閉じる・閉じたら押したボタンへ戻る。
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { renderWithIntl } from '../_helpers/i18n';
import { OptionSelectModal } from '@/components/OptionSelectModal';
import type { OptionGroup } from '@/lib/menuOptions';

const OPTIONS: OptionGroup[] = [
  {
    id: 'size',
    name: 'サイズ',
    type: 'single',
    required: true,
    choices: [
      { id: 's', label: 'S', priceDelta: '0' },
      { id: 'm', label: 'M', priceDelta: '50' },
      { id: 'l', label: 'L', priceDelta: '100' },
    ],
  },
  {
    id: 'topping',
    name: 'トッピング',
    type: 'multi',
    choices: [
      { id: 'egg', label: '卵', priceDelta: '80' },
      { id: 'cheese', label: 'チーズ', priceDelta: '100' },
    ],
  },
];

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>ラーメン</button>
      <OptionSelectModal
        open={open}
        itemName="ラーメン"
        basePrice="800"
        options={OPTIONS}
        symbol="JPYC"
        onConfirm={vi.fn()}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
      <button type="button">背後のボタン</button>
    </>
  );
}

describe('OptionSelectModal: focus 管理 (D1)', () => {
  it('開くと dialog へ focus・Tab は中だけを回る・Escape で閉じて押したボタンへ戻る', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithIntl(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'ラーメン' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'ラーメン' });
    expect(dialog).toHaveFocus();

    const radioS = within(dialog).getByRole('radio', { name: 'S' });
    const egg = within(dialog).getByRole('checkbox', { name: /卵/ });
    const cheese = within(dialog).getByRole('checkbox', { name: /チーズ/ });
    const cancel = within(dialog).getByRole('button', { name: 'キャンセル' });
    const add = within(dialog).getByRole('button', { name: 'カートに追加' });

    // サイズのラジオは選択中の 1 つだけが Tab の停止位置 (M・L は矢印キーで移る)。
    await user.tab();
    expect(radioS).toHaveFocus();
    await user.tab();
    expect(egg).toHaveFocus();
    await user.tab();
    expect(cheese).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(add).toHaveFocus();
    // 末尾から先頭へ回る (背後のボタンへ抜けない)。
    await user.tab();
    expect(radioS).toHaveFocus();
    await user.tab({ shift: true });
    expect(add).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('選択を変えたラジオが Tab の停止位置になる', async () => {
    const user = userEvent.setup();
    renderWithIntl(<Harness />);
    await user.click(screen.getByRole('button', { name: 'ラーメン' }));
    const dialog = screen.getByRole('dialog', { name: 'ラーメン' });
    const radioL = within(dialog).getByRole('radio', { name: /^L/ });
    await user.click(radioL);
    expect(radioL).toBeChecked();
    // 「キャンセル」から Shift+Tab で戻ると、トッピングを経て選択中の L に止まる。
    within(dialog).getByRole('button', { name: 'キャンセル' }).focus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(radioL).toHaveFocus();
    await user.tab({ shift: true });
    // 先頭の停止位置 (L) から Shift+Tab で末尾 (カートに追加) へ回る。
    expect(within(dialog).getByRole('button', { name: 'カートに追加' })).toHaveFocus();
  });

  it('IME の変換中の Escape では閉じない', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithIntl(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'ラーメン' }));
    const dialog = screen.getByRole('dialog', { name: 'ラーメン' });
    fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});
