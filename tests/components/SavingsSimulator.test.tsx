import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '../_helpers/i18n';
import { SavingsSimulator } from '@/components/SavingsSimulator';
import { DISCLOSED_RECOVER_FEE } from '@/lib/legal';

// 既定 = 月商 100 万円 × カード 3.24%・平均決済額 1,000 円 (最低額より料率側を適用)。
// この既定額では年間差額 = 1,000,000 × 12 × (0.0324 − 0.01)
// = 268,800 円 = 27 万円 (round)。整数円で計算し float の見た目誤差を出さない。
describe('SavingsSimulator', () => {
  it('ja: 平均決済額 100 円 / QR 1.98% のヒーローは負のゼロではなく 0', () => {
    renderWithIntl(<SavingsSimulator />);
    fireEvent.click(screen.getByRole('button', { name: 'コード決済 1.98%' }));
    fireEvent.change(screen.getByRole('slider', { name: '平均決済額' }), { target: { value: '100' } });
    expect(screen.getByText('0', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('-0', { exact: true })).not.toBeInTheDocument();
  });

  it.each(['ja', 'en'] as const)('%s: 150 円の決済では最低利用料を反映し、年間差額は 77,600 円', (locale) => {
    renderWithIntl(<SavingsSimulator />, { locale });
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? 'コード決済 1.98%' : 'QR pay 1.98%' }));
    fireEvent.change(screen.getByRole('slider', { name: locale === 'ja' ? '平均決済額' : 'Average payment amount' }), { target: { value: '150' } });
    expect(screen.getByText(locale === 'ja' ? /¥77,600 \/ 年/ : '77,600')).toBeInTheDocument();
  });

  it.each([200, 250, 1000])('%i 円の決済では料率側を適用する', (ticket) => {
    renderWithIntl(<SavingsSimulator />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'QR pay 1.98%' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Average payment amount' }), { target: { value: String(ticket) } });
    expect(screen.getByText('117,600')).toBeInTheDocument();
  });

  it.each(['ja', 'en'] as const)('%s: 最低額で比較先より割高になる場合もマイナスの差額を示す', (locale) => {
    renderWithIntl(<SavingsSimulator />, { locale });
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? 'コード決済 1.98%' : 'QR pay 1.98%' }));
    fireEvent.change(screen.getByRole('slider', { name: locale === 'ja' ? '平均決済額' : 'Average payment amount' }), { target: { value: '100' } });
    expect(screen.getByText(locale === 'ja' ? /-¥2,400 \/ 年/ : '-2,400')).toBeInTheDocument();
    expect(screen.getByText(locale === 'ja' ? '手数料の差額（マイナスは OpenPay が割高）' : 'fee difference (negative means OpenPay costs more)')).toBeInTheDocument();
  });

  it.each(['ja', 'en'] as const)('%s: 開示 SoT から料率・1 回あたりの最低額・計算の前提を表示する', (locale) => {
    renderWithIntl(<SavingsSimulator />, { locale });
    const note = screen.getByText(locale === 'ja' ? /全決済が平均決済額と同額/ : /every payment equals the average/);
    expect(note).toHaveTextContent(`${DISCLOSED_RECOVER_FEE.percentFromJulyBps / 100}%`);
    expect(note).toHaveTextContent(`${DISCLOSED_RECOVER_FEE.floorJpyc} JPYC`);
    expect(note).toHaveTextContent(locale === 'ja' ? '1 回あたり' : 'per payment');
    expect(note).toHaveTextContent(locale === 'ja' ? 'JPYC ガスレス' : 'gasless JPYC');
    expect(note).not.toHaveTextContent('0%');
  });

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
    // 平均決済額は既定の 1,000 円のままなので料率側を適用:
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
    // 平均決済額は既定の 1,000 円のままなので料率側を適用:
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
