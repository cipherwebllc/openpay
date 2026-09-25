import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { CsvPassModal } from '@/components/CsvPassModal';
import { QrPreviewModal } from '@/components/QrPreviewModal';

// 支払い処理は置換し、状態によって変わる操作対象を本物の modal 内に置く。
vi.mock('@/components/CsvPassPaywall', () => ({
  CsvPassPaywall: () => (
    <>
      <input aria-label="Confirmation" />
      <a href="#terms">Terms</a>
      <button disabled>Unavailable</button>
      <button tabIndex={-1}>Programmatic focus only</button>
      <div hidden><button>Hidden</button></div>
      <div style={{ display: 'none' }}><button>Not displayed</button></div>
      <div style={{ visibility: 'hidden' }}><button>Invisible</button></div>
    </>
  ),
}));

function qrModal(withDetails = false, onClose = vi.fn()) {
  return (
    <QrPreviewModal
      open
      onClose={onClose}
      labels={{ title: 'QR preview', close: 'Close', eyebrow: 'QR', copy: 'Copy', copied: 'Copied' }}
      qrValue="https://test.local/pay"
      qrRef={createRef<HTMLDivElement>()}
      storeName="Store"
      amountText="100 JPYC"
      chainText="Polygon"
      copied={false}
      onCopy={vi.fn()}
      eip681={withDetails ? {
        uri: 'ethereum:0xabc',
        copied: false,
        onCopy: vi.fn(),
        title: 'Compatible QR',
        badge: 'Advanced',
        description: 'Fallback',
        copy: 'Copy URI',
        copiedLabel: 'Copied URI',
      } : undefined}
    />
  );
}

describe.each([
  ['QrPreviewModal', (onClose = vi.fn()) => qrModal(false, onClose)],
  ['CsvPassModal', (onClose = vi.fn()) => <CsvPassModal open onClose={onClose} />],
] as const)('%s focus trap (B-R11f)', (_name, modal) => {
  it('初期 focus を保ち、Tab / Shift+Tab が先頭と末尾で循環する', async () => {
    const user = userEvent.setup();
    render(<><button>Before</button>{modal()}<button>After</button></>);
    const dialog = screen.getByRole('dialog');
    const first = within(dialog).getAllByRole('button')[0];
    const last = within(dialog).queryByRole('link') ?? within(dialog).getByRole('button', { name: 'Copy' });
    expect(dialog).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    const input = within(dialog).queryByRole('textbox');
    expect(input ?? last).toHaveFocus();
    if (input) await user.tab();
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab({ shift: true });
    expect(input ?? first).toHaveFocus();

    dialog.focus();
    await user.tab();
    expect(first).toHaveFocus();
  });

  it('外へ移った focus は次の Tab / Shift+Tab で modal 内に戻る', async () => {
    const user = userEvent.setup();
    render(<><button>Outside</button>{modal()}</>);
    const dialog = screen.getByRole('dialog');
    const first = within(dialog).getAllByRole('button')[0];
    const last = within(dialog).queryByRole('link') ?? within(dialog).getByRole('button', { name: 'Copy' });
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    await user.tab();
    expect(first).toHaveFocus();
    outside.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('ブラウザの標準 Tab 移動に依存せず、内部の次 / 前へ移動する', () => {
    render(modal());
    const dialog = screen.getByRole('dialog');
    const first = within(dialog).getAllByRole('button')[0];
    const next = within(dialog).queryByRole('textbox') ?? within(dialog).getByRole('button', { name: 'Copy' });
    first.focus();
    // fireEvent は native の Tab 移動を行わない。false は preventDefault 済みを表す。
    expect(fireEvent.keyDown(first, { key: 'Tab' })).toBe(false);
    expect(next).toHaveFocus();
    expect(fireEvent.keyDown(next, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(first).toHaveFocus();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('IME 中は Escape / Tab を処理しない (%j)', (ime) => {
    const onClose = vi.fn();
    render(modal(onClose));
    const first = within(screen.getByRole('dialog')).getAllByRole('button')[0];
    first.focus();
    expect(fireEvent.keyDown(first, { key: 'Tab', ...ime })).toBe(true);
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape', ...ime });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

it.each([false, true])('disabled 化した active から DOM 上の次 / 前へ移動する (shift=%s)', (shiftKey) => {
  render(<CsvPassModal open onClose={vi.fn()} />);
  const first = screen.getByRole('button', { name: '閉じる' });
  const input = screen.getByRole('textbox') as HTMLInputElement;
  const last = screen.getByRole('link', { name: 'Terms' });
  input.focus();
  input.disabled = true;
  expect(input).toHaveFocus();
  expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey })).toBe(false);
  expect(shiftKey ? first : last).toHaveFocus();

  // DOM 上に次 / 前の候補が無ければ、反対側の端へ戻る。
  const edge = shiftKey ? first : last;
  edge.focus();
  edge.tabIndex = -1;
  expect(fireEvent.keyDown(edge, { key: 'Tab', shiftKey })).toBe(false);
  expect(shiftKey ? last : first).toHaveFocus();
});

it('祖先の visibility:hidden を子の visible で上書きでき、display:none は上書きできない', () => {
  render(<CsvPassModal open onClose={vi.fn()} />);
  const visible = screen.getByText('Invisible');
  visible.style.visibility = 'visible';
  screen.getByText('Not displayed').style.visibility = 'visible';
  const dialog = screen.getByRole('dialog');
  expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false);
  expect(visible).toHaveFocus();
  expect(fireEvent.keyDown(visible, { key: 'Tab', shiftKey: true })).toBe(false);
  expect(screen.getByRole('link', { name: 'Terms' })).toHaveFocus();
});

it('QR の閉じた details は summary で循環し、展開後は内部のボタンまで辿れる', async () => {
  const user = userEvent.setup();
  render(<>{qrModal(true)}<button>Outside</button></>);
  const first = screen.getByRole('button', { name: 'Close' });
  const summary = screen.getByText('Compatible QR').closest('summary')!;
  await user.tab({ shift: true });
  expect(summary).toHaveFocus();
  await user.tab();
  expect(first).toHaveFocus();

  await user.click(summary);
  summary.focus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Copy URI' })).toHaveFocus();
  await user.tab();
  expect(first).toHaveFocus();

  await user.click(summary);
  first.focus();
  await user.tab({ shift: true });
  expect(summary).toHaveFocus();
  await user.tab();
  expect(first).toHaveFocus();
});
