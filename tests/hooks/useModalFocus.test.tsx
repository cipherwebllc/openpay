// useModalFocus を使うモーダルどうしの重なり: 開いた順のスタックの最上位だけがキーを処理する。
// 下は上に譲り、上は focus が下に残っていても自分の Escape・Tab の循環・入口への移動を行う (1 回の Tab で 1 歩)。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useModalFocus } from '@/hooks/useModalFocus';

function Modal({
  name,
  onClose,
  disabled = false,
  children,
}: {
  name: string;
  onClose: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { open: true, onEscape: onClose });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1}>
      {children}
      <button type="button" disabled={disabled}>{name} 1</button>
      <button type="button" disabled={disabled}>{name} 2</button>
    </div>
  );
}

function Stack({
  upperFirstInDom,
  onLowerClose,
  onUpperClose,
  upperDisabled = false,
  upperChildren,
}: {
  upperFirstInDom: boolean;
  onLowerClose: () => void;
  onUpperClose: () => void;
  upperDisabled?: boolean;
  upperChildren?: ReactNode;
}) {
  const [upperOpen, setUpperOpen] = useState(false);
  const lower = (
    <Modal key="lower" name="下" onClose={onLowerClose}>
      <button type="button" onClick={() => setUpperOpen(true)}>上を開く</button>
    </Modal>
  );
  const upper = upperOpen ? (
    <Modal
      key="upper"
      name="上"
      disabled={upperDisabled}
      onClose={() => {
        onUpperClose();
        setUpperOpen(false);
      }}
    >
      {upperChildren}
    </Modal>
  ) : null;
  return <>{upperFirstInDom ? [upper, lower] : [lower, upper]}</>;
}

async function openStack(props: Partial<Parameters<typeof Stack>[0]> & { upperFirstInDom: boolean }) {
  const user = userEvent.setup();
  const onLowerClose = vi.fn();
  const onUpperClose = vi.fn();
  render(<Stack onLowerClose={onLowerClose} onUpperClose={onUpperClose} {...props} />);
  await user.click(screen.getByRole('button', { name: '上を開く' }));
  const lower = screen.getByRole('dialog', { name: '下' });
  const upper = screen.getByRole('dialog', { name: '上' });
  return { user, onLowerClose, onUpperClose, lower, upper };
}

const extraNodes: HTMLElement[] = [];
afterEach(() => {
  for (const node of extraNodes.splice(0)) node.remove();
});

describe.each([
  ['上が DOM の後ろ', false],
  ['上が DOM の前', true],
] as const)('useModalFocus: hook を持つモーダル 2 枚重ね (%s)', (_label, upperFirstInDom) => {
  it('Escape は上だけを閉じ (focus が下に残っていても)、閉じたら下が戻る', async () => {
    const { user, onLowerClose, onUpperClose, lower } = await openStack({ upperFirstInDom });
    within(lower).getByRole('button', { name: '下 1' }).focus();
    await user.keyboard('{Escape}');
    expect(onUpperClose).toHaveBeenCalledOnce();
    expect(onLowerClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '上' })).toBeNull();
    // 下へ移っていた focus はそのまま (閉じた上が奪わない)。下の Tab の循環と Escape が戻る。
    expect(within(lower).getByRole('button', { name: '下 1' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '上を開く' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(lower).getByRole('button', { name: '下 2' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onLowerClose).toHaveBeenCalledOnce();
  });

  it('Tab は上の中で循環し、focus が下にあっても上へ入る', async () => {
    const { user, lower, upper } = await openStack({ upperFirstInDom });
    const first = within(upper).getByRole('button', { name: '上 1' });
    const second = within(upper).getByRole('button', { name: '上 2' });
    expect(upper).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(second).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(second).toHaveFocus();
    within(lower).getByRole('button', { name: '下 1' }).focus();
    await user.tab();
    expect(upper.contains(document.activeElement)).toBe(true);
  });

  it('body からの Tab は上の入口へ 1 回だけ進む (下と上が同じ Tab を二重に処理しない)', async () => {
    const { user, upper } = await openStack({ upperFirstInDom });
    upper.blur();
    expect(document.activeElement).toBe(document.body);
    await user.tab();
    expect(within(upper).getByRole('button', { name: '上 1' })).toHaveFocus();
  });

  it('上の操作がすべて disabled なら、Tab は上のモーダル自身へ (下へ抜けない)', async () => {
    const { user, lower, upper } = await openStack({ upperFirstInDom, upperDisabled: true });
    within(lower).getByRole('button', { name: '下 1' }).focus();
    await user.tab();
    expect(upper).toHaveFocus();
  });

  it('中の部品が preventDefault した Escape では閉じない (二重処理しない)', async () => {
    const { user, onUpperClose, onLowerClose, upper } = await openStack({
      upperFirstInDom,
      upperChildren: (
        <input
          aria-label="候補つき入力"
          onKeyDown={(e: ReactKeyboardEvent) => {
            if (e.key === 'Escape') e.preventDefault();
          }}
        />
      ),
    });
    within(upper).getByRole('textbox', { name: '候補つき入力' }).focus();
    await user.keyboard('{Escape}');
    expect(onUpperClose).not.toHaveBeenCalled();
    expect(onLowerClose).not.toHaveBeenCalled();
  });
});

it('hook を使わない上のモーダルの操作がすべて disabled なら、Tab はそのモーダル自身へ移す', async () => {
  const user = userEvent.setup();
  render(<Modal name="下" onClose={vi.fn()} />);
  const card = document.createElement('div');
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-modal', 'true');
  const disabled = document.createElement('button');
  disabled.disabled = true;
  card.appendChild(disabled);
  document.body.appendChild(card);
  extraNodes.push(card);
  screen.getByRole('button', { name: '下 1' }).focus();
  await user.tab();
  expect(card).toHaveFocus();
  expect(card).toHaveAttribute('tabindex', '-1');
});
