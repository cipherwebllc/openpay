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
    // QrPreviewModal の末尾は「リンクを表示」の折りたたみ (summary・2026-10 磨き上げ P5)。
    const last =
      within(dialog).queryByRole('link') ??
      dialog.querySelector<HTMLElement>('summary') ??
      within(dialog).getByRole('button', { name: 'Copy' });
    expect(dialog).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    // 先頭と末尾の間の操作 (CsvPass = 入力欄 / QR = 「Copy」・末尾は「リンクを表示」)。
    const input =
      within(dialog).queryByRole('textbox') ??
      (dialog.querySelector('summary') ? within(dialog).getByRole('button', { name: 'Copy' }) : null);
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
    // QrPreviewModal の末尾は「リンクを表示」の折りたたみ (summary・2026-10 磨き上げ P5)。
    const last =
      within(dialog).queryByRole('link') ??
      dialog.querySelector<HTMLElement>('summary') ??
      within(dialog).getByRole('button', { name: 'Copy' });
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

// 上に重なった別のモーダル (ウォレット接続の QR = Reown AppKit の w3m-modal 等) が focus を持つ間は、
// 下の modal が Tab で focus を引き戻したり Escape で一緒に閉じたりしない (useModalFocus・D11)。
it.each([
  ['light DOM', false],
  ['shadow DOM', true],
] as const)('上に重なった別の aria-modal (%s) のキーは奪わない', (_label, shadow) => {
  const onClose = vi.fn();
  render(<CsvPassModal open onClose={onClose} />);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
  const card = document.createElement('div');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const inner = document.createElement('button');
  card.appendChild(inner);
  root.appendChild(card);
  inner.focus();
  expect(fireEvent.keyDown(inner, { key: 'Tab' })).toBe(true);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(false);
  fireEvent.keyDown(inner, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  host.remove();
});

// 上のモーダルが開いていても focus が下 (または body) に残ることがある (AppKit は再表示のとき card の描画前に
// focus を試みる)。focus の位置ではなく「上に開いたモーダルがあるか」で止め、上が閉じたら元に戻す。
it.each([
  ['shadow DOM (body 直下の host)', true],
  ['light DOM (後ろに描画された portal)', false],
] as const)('上に開いた aria-modal (%s) がある間は、focus が下や body にあっても Tab / Escape を処理しない', (_label, shadow) => {
  const onClose = vi.fn();
  render(<CsvPassModal open onClose={onClose} />);
  const dialog = screen.getByRole('dialog');
  const close = within(dialog).getByRole('button', { name: '閉じる' });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
  const card = document.createElement('div');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  card.appendChild(document.createElement('button'));
  root.appendChild(card);

  for (const target of [close, document.body]) {
    if (target === close) close.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
    expect(fireEvent.keyDown(target, { key: 'Tab' })).toBe(true);
    fireEvent.keyDown(target, { key: 'Escape' });
  }
  expect(onClose).not.toHaveBeenCalled();

  // 上のモーダルが閉じたら (DOM から外れたら)、下の Tab / Escape が戻る。
  host.remove();
  close.focus();
  expect(fireEvent.keyDown(close, { key: 'Tab' })).toBe(false);
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});
