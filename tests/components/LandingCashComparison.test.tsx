import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ja from '../../messages/ja.json';
import { LandingCashComparison } from '@/components/LandingCashComparison';

// 実 ja コピーで assertion したいので getTranslations を Landing 実辞書引きに mock。
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string) =>
    (ja.Landing as Record<string, string>)[k] ?? k,
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
      screen.getByText('その判断のまま、損ゼロで置ける選択肢があります。'),
    ).toBeInTheDocument();

    // 比較表の 4 行ラベル
    expect(screen.getByText('決済手数料')).toBeInTheDocument();
    expect(screen.getByText('入金')).toBeInTheDocument();
    expect(screen.getByText('導入費と機器')).toBeInTheDocument();
    expect(screen.getByText('解約縛り')).toBeInTheDocument();

    // 手数料セルの数値 framing (カード 1.98〜3.24% / OpenPay 0%〜1%)
    expect(screen.getByText('1.98〜3.24%')).toBeInTheDocument();
    expect(screen.getByText('0%〜1%')).toBeInTheDocument();
    expect(
      screen.getByText('お客様ガス代負担なら 0%・ガスレス決済で 1%'),
    ).toBeInTheDocument();

    // 脚注 (一般的な料率の例)
    expect(
      screen.getByText(/カード 3.24%・コード決済 1.98% は一般的な料率の例/),
    ).toBeInTheDocument();
  });

  it('円⇄JPYC の 1:1 図解とシミュレータ (client 子) を描画', async () => {
    const ui = await LandingCashComparison();
    render(ui);
    expect(screen.getByText('円と JPYC は 1:1')).toBeInTheDocument();
    expect(screen.getByText('1:1 で換金')).toBeInTheDocument();
    expect(screen.getByTestId('savings-simulator')).toBeInTheDocument();
  });
});
