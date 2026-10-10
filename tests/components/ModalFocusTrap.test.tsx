import { afterEach, describe, expect, it, vi } from 'vitest';
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

// 上のモーダルを組み立てる。body 直下の host → (shadow DOM なら open root) → wrapper → aria-modal の card → ボタン。
const upperHosts: HTMLElement[] = [];
afterEach(() => {
  // 途中で落ちたテストの上のモーダルを次のテストへ持ち越さない。
  for (const host of upperHosts.splice(0)) host.remove();
});

function mountUpperModal(shadow: boolean) {
  const host = document.createElement('div');
  upperHosts.push(host);
  document.body.appendChild(host);
  const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
  const wrapper = document.createElement('div');
  const card = document.createElement('div');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const inner = document.createElement('button');
  inner.textContent = 'QR を閉じる';
  card.appendChild(inner);
  wrapper.appendChild(card);
  root.appendChild(wrapper);
  // 上のモーダルの中で focus を持っている要素 (shadow DOM なら root 側の activeElement)。
  const focused = () => (shadow ? host.shadowRoot!.activeElement : document.activeElement);
  return { host, wrapper, card, inner, focused };
}

// 上のモーダルが開いていても focus が下 (または body) に残ることがある (AppKit は開き直すとき card の描画前に
// focus を試み、その後の Tab でも描画前に取った card = null を見るので自分では取り戻せない)。下は Escape で
// 閉じず、Tab は上のモーダルの入口へ移す。上が閉じたら下の Tab / Escape が戻る。
it.each([
  ['shadow DOM (body 直下の host)', true],
  ['light DOM (後ろに描画された portal)', false],
] as const)('上に開いた aria-modal (%s) があり focus が下や body にあると、Tab で上の入口へ移し Escape は処理しない', async (_label, shadow) => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<CsvPassModal open onClose={onClose} />);
  const dialog = screen.getByRole('dialog');
  const close = within(dialog).getByRole('button', { name: '閉じる' });
  const upper = mountUpperModal(shadow);

  close.focus();
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  await user.tab();
  expect(upper.focused()).toBe(upper.inner);

  close.focus();
  await user.tab({ shift: true });
  expect(upper.focused()).toBe(upper.inner);

  // focus を body へ落とす (shadow DOM の中の要素は host ではなく要素自身を blur する)。
  (upper.focused() as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  await user.tab();
  expect(upper.focused()).toBe(upper.inner);
  expect(onClose).not.toHaveBeenCalled();

  // 上のモーダルが閉じたら (DOM から外れたら)、下の Tab の循環と Escape が戻る。
  upper.host.remove();
  close.focus();
  await user.tab({ shift: true });
  expect(screen.getByRole('link', { name: 'Terms' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
});

// DOM に残したまま隠して閉じるモーダルは「上に開いている」と数えない (数えると下の Tab / Escape が戻らない)。
it.each([
  ['light DOM・hidden 属性の祖先', false, (m: ReturnType<typeof mountUpperModal>) => { m.wrapper.hidden = true; }],
  ['light DOM・display:none の祖先', false, (m: ReturnType<typeof mountUpperModal>) => { m.wrapper.style.display = 'none'; }],
  ['light DOM・visibility:hidden', false, (m: ReturnType<typeof mountUpperModal>) => { m.card.style.visibility = 'hidden'; }],
  ['light DOM・inert の祖先', false, (m: ReturnType<typeof mountUpperModal>) => { m.wrapper.setAttribute('inert', ''); }],
  ['shadow DOM・display:none のホスト', true, (m: ReturnType<typeof mountUpperModal>) => { m.host.style.display = 'none'; }],
  ['shadow DOM・hidden 属性のホスト', true, (m: ReturnType<typeof mountUpperModal>) => { m.host.hidden = true; }],
  ['shadow DOM・inert のホスト', true, (m: ReturnType<typeof mountUpperModal>) => { m.host.setAttribute('inert', ''); }],
  ['shadow DOM・中の display:none', true, (m: ReturnType<typeof mountUpperModal>) => { m.wrapper.style.display = 'none'; }],
  ['shadow DOM・visibility:hidden の card', true, (m: ReturnType<typeof mountUpperModal>) => { m.card.style.visibility = 'hidden'; }],
] as const)('隠れた aria-modal (%s) は上のモーダルと数えず、下の Tab / Escape を止めない', (_label, shadow, hide) => {
  const onClose = vi.fn();
  render(<CsvPassModal open onClose={onClose} />);
  const close = within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' });
  const upper = mountUpperModal(shadow);
  hide(upper);
  close.focus();
  expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false);
  expect(screen.getByRole('link', { name: 'Terms' })).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  upper.host.remove();
});

// Tab / Escape 以外 (文字入力・矢印) では、上のモーダルを探す DOM 検索を走らせない。
it('Tab / Escape 以外のキーでは DOM を検索しない', () => {
  render(<CsvPassModal open onClose={vi.fn()} />);
  const input = screen.getByRole('textbox');
  const upper = mountUpperModal(true);
  const spies = [Document.prototype, Element.prototype, DocumentFragment.prototype].map((proto) =>
    vi.spyOn(proto, 'querySelectorAll'),
  );
  try {
    input.focus();
    for (const key of ['a', 'ArrowDown', 'Enter', ' ']) fireEvent.keyDown(input, { key });
    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0);
    // Tab では検索する (spy が効いていることの確認)。
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBeGreaterThan(0);
  } finally {
    for (const spy of spies) spy.mockRestore();
    upper.host.remove();
  }
});
