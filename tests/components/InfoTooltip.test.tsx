import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { InfoTooltip } from '@/components/InfoTooltip';
import { breakdownRow } from '@/components/PaymentBreakdownRows';

describe('InfoTooltip', () => {
  it('初期 (closed): tooltip は描画されず、(?) ボタンのみ', () => {
    render(<InfoTooltip text="Pimlico ERC20 Paymaster で USDC で支払い" label="ガス代" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(
      screen.queryByText(/Pimlico ERC20 Paymaster/),
    ).toBeNull();
  });

  it('クリック → tooltip 表示、再クリック → 閉じる (toggle)', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="hint message" label="ガス代" />);
    const btn = screen.getByRole('button');
    await user.click(btn);
    expect(screen.getByRole('tooltip')).toHaveTextContent('hint message');
    await user.click(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keyboard (Enter) でも開閉できる (a11y)', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="kbd message" label="ガス代" />);
    const btn = screen.getByRole('button');
    btn.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('kbd message');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ESC キーで閉じる', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="esc message" label="ガス代" />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('外側クリックで閉じる', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <InfoTooltip text="outside click" label="ガス代" />
        <button type="button" data-testid="outside">Outside</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'ガス代 の詳細' }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await user.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a11y: aria-expanded / aria-describedby が状態に応じて切替', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip text="a11y message" label="ガス代" />);
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

  // 全レビュー第 8 回 D-2: 以前は全行が同じ固定の名前で、どの額の説明かが読み上げで分からなかった。
  // 名前は行の可視ラベル (内訳の dt の文字) から作り (掟 8)、開閉では変えず aria-expanded だけが動く。
  describe('名前に行の可視ラベルが入る (D-2)', () => {
    function renderRows(locale: 'ja' | 'en') {
      const labels =
        locale === 'ja'
          ? ['ネットワーク手数料見積 (顧客負担)', 'ネットワーク手数料']
          : ['Estimated network fee (customer pays)', 'Network fee'];
      render(
        <dl>
          {breakdownRow({ label: labels[0], value: '0.10 USDC', tooltip: 'first' }, 'a')}
          {breakdownRow({ label: labels[1], value: '0.20 USDC', tooltip: 'second' }, 'b')}
        </dl>,
        { locale },
      );
      return labels;
    }

    it.each([
      ['ja', (label: string) => `${label} の詳細`],
      ['en', (label: string) => `${label} details`],
    ] as const)('%s: 各行のボタン名がその行のラベルを含み、行ごとに違う', (locale, nameOf) => {
      const labels = renderRows(locale);
      const buttons = screen.getAllByRole('button');
      expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(labels.map(nameOf));
      for (const [i, label] of labels.entries()) {
        // 名前は可視ラベルから導く: その行の dt の文字がボタン名に含まれる (掟 8)
        const dt = buttons[i].closest('dt')!;
        expect(dt.textContent).toBe(`${label}?`);
        expect(buttons[i].getAttribute('aria-label')).toContain(label);
      }
    });

    it('開いても名前は変わらず、aria-expanded だけが開閉を伝える', async () => {
      const user = userEvent.setup();
      renderRows('ja');
      const btn = screen.getByRole('button', { name: 'ネットワーク手数料 の詳細' });
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      await user.click(btn);
      expect(btn).toHaveAccessibleName('ネットワーク手数料 の詳細');
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('tooltip')).toHaveTextContent('second');
      await user.click(btn);
      expect(btn).toHaveAccessibleName('ネットワーク手数料 の詳細');
      expect(btn).toHaveAttribute('aria-expanded', 'false');
    });
  });

  // 全レビュー第 8 回 D-2: 16px の丸だけが押せる範囲だった (WCAG 2.2 の最小 24px 未満)。見た目の丸 (h-4 w-4 =
  // 16px・border 1px) は変えず、::after を出して 24px を押せるようにする。absolute の基準は border の内側 (14px)
  // なので四方 5px (-inset-[5px]) で 24px (4px だと 22px になるのを Chromium の実測で確認)。ボタンの箱は変えない
  // ので行の高さも動かない。jsdom はレイアウトを持たないので class で固定する。
  it('押せる範囲: 16px の丸 (border 1px) + ::after で border の内側から四方 5px = 24px', () => {
    render(<InfoTooltip text="target" label="ガス代" />);
    const classes = screen.getByRole('button').className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(['relative', 'h-4', 'w-4', 'border', 'after:absolute', 'after:-inset-[5px]']),
    );
  });
});
