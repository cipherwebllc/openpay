import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import { PayStepStrip } from '@/components/PayStepStrip';

describe('PayStepStrip', () => {
  it('3 ステップ (接続→確認→署名) + 「アプリ/登録不要」を表示', () => {
    render(<PayStepStrip />);
    expect(screen.getByText('ウォレット接続')).toBeInTheDocument();
    expect(screen.getByText('金額を確認')).toBeInTheDocument();
    expect(screen.getByText('署名で完了')).toBeInTheDocument();
    expect(screen.getByText(/アプリのDL・登録は不要/)).toBeInTheDocument();
    // 番号 1/2/3 のステップ表記
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
