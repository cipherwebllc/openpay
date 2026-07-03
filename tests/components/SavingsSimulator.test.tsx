import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';
import { SavingsSimulator } from '@/components/SavingsSimulator';

// 既定 = 月商 100 万円 × カード 3.24%。年間差額 = 1,000,000 × 12 × (0.0324 − 0.01)
// = 268,800 円 = 27 万円 (round)。整数円で計算し float の見た目誤差を出さない。
describe('SavingsSimulator', () => {
  it('既定値 (100 万円 / カード 3.24%) で年間 27 万円・正確な円差額を表示', () => {
    renderWithIntl(<SavingsSimulator />);
    // 月商スライダー現在値 (万円表示)
    expect(screen.getByText('100万円')).toBeInTheDocument();
    // ヒーロー = 27 (万円)
    expect(screen.getByText('27')).toBeInTheDocument();
    expect(screen.getByText('万円')).toBeInTheDocument();
    // 正確な円差額の補足
    expect(screen.getByText(/¥268,800 \/ 年/)).toBeInTheDocument();
  });

  it('比較チップをコード決済 1.98% に切替えると年間 12 万円に更新', async () => {
    const user = userEvent.setup();
    renderWithIntl(<SavingsSimulator />);
    await user.click(
      screen.getByRole('button', { name: 'コード決済 1.98%' }),
    );
    // 1,000,000 × 12 × (0.0198 − 0.01) = 117,600 円 = 12 万円
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/¥117,600 \/ 年/)).toBeInTheDocument();
    // aria-pressed が切替わる
    expect(
      screen.getByRole('button', { name: 'コード決済 1.98%' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('スライダーを 500 万円に変更するとヒーローが更新される', () => {
    renderWithIntl(<SavingsSimulator />);
    const slider = screen.getByLabelText('月商');
    fireEvent.change(slider, { target: { value: '5000000' } });
    expect(screen.getByText('500万円')).toBeInTheDocument();
    // 5,000,000 × 12 × 0.0224 = 1,344,000 円 = 134 万円
    expect(screen.getByText('134')).toBeInTheDocument();
  });

  it('en ロケールでは full 円をヒーローに表示 (万円ヒーローは使わない)', () => {
    renderWithIntl(<SavingsSimulator />, { locale: 'en' });
    // ヒーロー = 268,800 (full 円)、unit = yen
    expect(screen.getByText('268,800')).toBeInTheDocument();
    expect(screen.getByText('yen')).toBeInTheDocument();
  });
});
