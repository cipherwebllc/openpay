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
  it('見出し・サブ・比較表の 3 行と OpenPay 列の framing を描画', async () => {
    const ui = await LandingCashComparison();
    render(ui);

    // 見出し + サブ
    expect(screen.getByText('現金に戻したお店へ')).toBeInTheDocument();
    expect(
      screen.getByText('そのまま追加できる選択肢です。'),
    ).toBeInTheDocument();

    // 比較表の 3 行ラベル。解約縛りの行は外した (縛りのない決済会社がある・景品表示法の有利誤認を避ける・2026-10-25)。
    expect(screen.getByText('決済手数料')).toBeInTheDocument();
    expect(screen.getByText('入金')).toBeInTheDocument();
    expect(screen.getByText('導入費と機器')).toBeInTheDocument();
    expect(screen.queryByText('解約縛り')).toBeNull();

    // OpenPay の手数料セル: 「0円〜」と、その条件 (お客様がガス代を払う通常決済) と上の端 (ガスレスの料率と最低額) を
    // 同じセルに置く (条件を脚注だけに置かない)。
    const feeCell = screen.getByText('0円〜').closest('td')!;
    expect(feeCell).toHaveTextContent('お客様がガス代を払う通常決済（レジ・決済QR）');
    expect(feeCell).toHaveTextContent('ガスレス決済は 1%・最低 2 JPYC（店舗負担）。モバイル注文は別料金。');
    expect(screen.queryByText('ガスレス 1%')).toBeNull();

    // カード・コード決済の列は、決済会社ごとに違う項目を一律に断定しない。料率は例であることをセルに書く。
    expect(screen.getByText('1.98〜3.24%（例）')).toBeInTheDocument();
    expect(screen.getAllByText('契約により異なる')).toHaveLength(2);
    expect(screen.queryByText('月2回・翌月')).toBeNull();
    expect(screen.queryByText('端末代・月額')).toBeNull();

    // 脚注: 公表料率の例・時点・会社やプランで違う
    expect(screen.getByText(/主な決済会社が公表している料率の例です（2026年10月時点）/)).toBeInTheDocument();
    expect(screen.getByText(/料率・入金の時期・費用は、決済会社やプランにより異なります/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '店頭キットを印刷する (無料)' }),
    ).toHaveAttribute('href', '/ja/kit');
  });

  it('シミュレータ (client 子) を描画し、1:1 の帯は出さない (「なぜ今」・JPYC の注記と重なるので外した)', async () => {
    const ui = await LandingCashComparison();
    render(ui);
    expect(screen.getByTestId('savings-simulator')).toBeInTheDocument();
    expect(screen.queryByText('円と JPYC は 1:1')).toBeNull();
    // 店頭キットへの入口は節の末尾 (試算の後ろ)。
    const kit = screen.getByRole('link', { name: '店頭キットを印刷する (無料)' });
    expect(screen.getByTestId('savings-simulator').compareDocumentPosition(kit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
