import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { InfoTooltip } from '@/components/InfoTooltip';

describe('InfoTooltip', () => {
  it('初期 (closed): tooltip は描画されず、(?) ボタンのみ', () => {
    render(<InfoTooltip text="Pimlico ERC20 Paymaster で USDC で支払い" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(
      screen.queryByText(/Pimlico ERC20 Paymaster/),
    ).toBeNull();
  });

  it('クリック → tooltip 表示、再クリック → 閉じる (toggle)', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="hint message" />);
    const btn = screen.getByRole('button');
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toHaveTextContent('hint message');
    await user.click(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keyboard (Enter) でも開閉できる (a11y)', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="kbd message" />);
    const btn = screen.getByRole('button');
    btn.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('kbd message');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ESC キーで閉じる', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="esc message" />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('外側クリックで閉じる', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoTooltip text="outside click" />
        <button type="button" data-testid="outside">Outside</button>
      </div>,
    );
    const trigger = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.includes('詳細'));
    if (!trigger) throw new Error('trigger not found');
    await user.click(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a11y: aria-expanded / aria-describedby が状態に応じて切替', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="a11y message" />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-describedby')).toBeNull();
    await user.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toMatch(/^tip-/);
    expect(screen.getByRole('tooltip').id).toBe(
      btn.getAttribute('aria-describedby'),
    );
  });
});
