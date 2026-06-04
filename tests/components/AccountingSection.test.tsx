import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { AccountingSection } from '@/components/AccountingSection';

const LABELS = {
  title: '記帳・会計',
  hint: 'ヒント',
  productName: '商品名',
  productNamePlaceholder: '商品名プレースホルダ',
  memo: 'メモ',
  memoPlaceholder: 'メモプレースホルダ',
  tax: '税',
  taxCustom: 'カスタム税率',
  receiptNo: '管理番号',
  receiptNoPlaceholder: 'R-001',
  generate: '採番',
  cartAutoNote: '商品名・税はカートから自動記録',
};

describe('AccountingSection', () => {
  it('manual: 商品名/メモ/税/管理番号を手入力。採番ボタン・cart注記は無い', async () => {
    const user = userEvent.setup();
    const onProductNameChange = vi.fn();
    render(
      <AccountingSection
        variant="manual"
        labels={LABELS}
        productName=""
        onProductNameChange={onProductNameChange}
        memo=""
        onMemoChange={vi.fn()}
        taxRate={null}
        taxCategory={null}
        onTaxChange={vi.fn()}
        receiptNo=""
        onReceiptNoChange={vi.fn()}
      />,
    );
    await user.type(screen.getByPlaceholderText('商品名プレースホルダ'), 'A');
    expect(onProductNameChange).toHaveBeenCalledWith('A');
    expect(screen.getByPlaceholderText('メモプレースホルダ')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('R-001')).toBeInTheDocument();
    // manual は採番ボタン無し (onGenerateReceiptNo 未指定) / cart注記も出ない。
    expect(screen.queryByRole('button', { name: '採番' })).toBeNull();
    expect(screen.queryByText('商品名・税はカートから自動記録')).toBeNull();
  });

  it('cart: cart注記 + 管理番号 + 採番。商品名/メモ手入力は出ない', async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(
      <AccountingSection
        variant="cart"
        labels={LABELS}
        receiptNo=""
        onReceiptNoChange={vi.fn()}
        onGenerateReceiptNo={onGenerate}
      />,
    );
    expect(screen.getByText('商品名・税はカートから自動記録')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('R-001')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('商品名プレースホルダ')).toBeNull();
    expect(screen.queryByPlaceholderText('メモプレースホルダ')).toBeNull();
    await user.click(screen.getByRole('button', { name: '採番' }));
    expect(onGenerate).toHaveBeenCalled();
  });

  it('管理番号 onChange を委譲する', async () => {
    const user = userEvent.setup();
    const onReceiptNoChange = vi.fn();
    render(
      <AccountingSection
        variant="cart"
        labels={LABELS}
        receiptNo=""
        onReceiptNoChange={onReceiptNoChange}
      />,
    );
    await user.type(screen.getByPlaceholderText('R-001'), 'X');
    expect(onReceiptNoChange).toHaveBeenCalledWith('X');
  });
});
