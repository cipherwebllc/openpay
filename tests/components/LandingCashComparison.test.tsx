import { createTranslator } from 'next-intl';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ja from '../../messages/ja.json';
import { LandingCashComparison } from '@/components/LandingCashComparison';

// 実辞書と ICU 補間で、料金定数が描画へ渡ることも検証する。
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async () => createTranslator({ locale: 'ja', messages: ja, namespace: 'Landing' }),
}));

// client 子 (useTranslations/useLocale) は intl provider が要るため mock (境界分離)。
vi.mock('@/components/SavingsSimulator', () => ({
  SavingsSimulator: () => <div data-testid="savings-simulator" />,
}));

describe('LandingCashComparison', () => {
  it('見出し・サブ・比較表の 4 行と OpenPay 列の framing を描画', async () => {
    const ui = await LandingCashComparison();
    render(ui);

    // 見出し + サブ
    expect(screen.getByText('現金に戻したお店へ')).toBeInTheDocument();
    expect(
      screen.getByText('そのまま追加できる選択肢です。'),
    ).toBeInTheDocument();

    // 比較表の 4 行ラベル
    expect(screen.getByText('決済手数料')).toBeInTheDocument();
    expect(screen.getByText('入金')).toBeInTheDocument();
    expect(screen.getByText('導入費と機器')).toBeInTheDocument();
    expect(screen.getByText('解約縛り')).toBeInTheDocument();

    // 手数料セルは「通常決済は無料 (レジ含む)・ガスレスは % と最低額」を区別する (2026-10-07 レジの通常決済の利用料を廃止)。
    expect(screen.getByText('1.98〜3.24%')).toBeInTheDocument();
    expect(screen.getByText('ガスレス 1%')).toBeInTheDocument();
    expect(
      screen.getByText(/お客様がガス代を払う通常決済は OpenPay 利用料無料（レジ含む）。ガスレス JPYC は 1%・最低 2 JPYC/),
    ).toBeInTheDocument();

    // 脚注 (一般的な料率の例)
    expect(
      screen.getByText(/カード 3.24%・コード決済 1.98% は一般的な料率の例/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '店頭キットを印刷する (無料)' }),
    ).toHaveAttribute('href', '/ja/kit');
  });

  it('円⇄JPYC の 1:1 図解とシミュレータ (client 子) を描画', async () => {
    const ui = await LandingCashComparison();
    render(ui);
    expect(screen.getByText('円と JPYC は 1:1')).toBeInTheDocument();
    expect(screen.getByText('1:1 で換金')).toBeInTheDocument();
    expect(screen.getByTestId('savings-simulator')).toBeInTheDocument();
  });
});
