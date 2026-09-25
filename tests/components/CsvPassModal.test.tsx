import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { CsvPassModal } from '@/components/CsvPassModal';
import ja from '@/messages/ja.json';

// 購入処理は境界で置換し、本物の modal の focus / close を検証する。
vi.mock('@/components/CsvPassPaywall', () => ({
  CsvPassPaywall: () => <p>CSV pass content</p>,
}));

function Parent({ onClose }: { onClose: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  return (
    <>
      <label>
        Outside input
        <input value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button onClick={() => setOpen(true)}>Open CSV pass</button>
      <CsvPassModal open={open} onClose={() => {
        onClose(value);
        setOpen(false);
      }} />
    </>
  );
}

describe('CsvPassModal focus (B-R11e)', () => {
  it('B-R11f: 操作対象が閉じるボタンだけでも Tab / Shift+Tab は外へ出ない', async () => {
    const user = userEvent.setup();
    render(<><CsvPassModal open onClose={vi.fn()} /><button>Outside</button></>);
    const close = screen.getByRole('button', { name: ja.CsvPass.close });
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
  });

  it('親の再描画で外側の入力から focus を奪わず、Escape は最新の onClose を使う', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Parent onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open CSV pass' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: ja.CsvPass.modalTitle });
    expect(dialog).toHaveFocus();

    const input = screen.getByRole('textbox', { name: 'Outside input' });
    expect(dialog).not.toContainElement(input);
    await user.type(input, 'AB');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('AB');
    expect(screen.getByRole('dialog')).toBe(dialog);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('AB');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close ボタンは最新の onClose を使い、閉じるたびに起点へ focus を戻す', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Parent onClose={onClose} />, { reactStrictMode: true });
    const opener = screen.getByRole('button', { name: 'Open CSV pass' });
    await user.click(opener);
    await user.type(screen.getByRole('textbox', { name: 'Outside input' }), 'A');
    await user.click(screen.getByRole('button', { name: ja.CsvPass.close }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('A');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();

    await user.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(opener).toHaveFocus();
  });

  it('root StrictMode でも Escape は 1 回だけ処理し、unmount で focus を戻して listener を解除する', async () => {
    const user = userEvent.setup();
    render(<button>Opener</button>);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    const onClose = vi.fn();
    // Provider より外側の StrictMode で、open 時の effect の setup / cleanup を再実行する。
    const { unmount } = render(<CsvPassModal open onClose={onClose} />, { reactStrictMode: true });
    expect(screen.getByRole('dialog')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(opener).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
