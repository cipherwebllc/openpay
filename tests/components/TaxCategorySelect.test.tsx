import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';
import { TaxCategorySelect } from '@/components/TaxCategorySelect';

function setup(over?: { taxRate?: number | null; taxCategory?: 'taxable_10' | 'taxable_8' | 'tax_free' | 'out_of_scope' | 'custom' | null }) {
  const onChange = vi.fn();
  render(
    <TaxCategorySelect
      taxRate={over?.taxRate ?? null}
      taxCategory={over?.taxCategory ?? null}
      onChange={onChange}
      ariaLabel="税率"
      customAriaLabel="カスタム税率"
    />,
  );
  return { onChange };
}

describe('TaxCategorySelect', () => {
  it('課税10% 選択で taxCategory + 既定税率を onChange', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.selectOptions(screen.getByLabelText('税率'), 'taxable_10');
    expect(onChange).toHaveBeenCalledWith({ taxCategory: 'taxable_10', taxRate: 10 });
  });

  it('非課税 選択で taxRate 0', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await user.selectOptions(screen.getByLabelText('税率'), 'tax_free');
    expect(onChange).toHaveBeenCalledWith({ taxCategory: 'tax_free', taxRate: 0 });
  });

  it('未選択 (none) で {null, null}', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ taxCategory: 'taxable_10', taxRate: 10 });
    await user.selectOptions(screen.getByLabelText('税率'), '');
    expect(onChange).toHaveBeenCalledWith({ taxCategory: null, taxRate: null });
  });

  it('非 custom では税率入力欄が出ない', () => {
    setup({ taxCategory: 'taxable_10', taxRate: 10 });
    expect(screen.queryByLabelText('カスタム税率')).toBeNull();
  });

  it('custom 選択時は税率入力欄が出て、入力で onChange', () => {
    const { onChange } = setup({ taxCategory: 'custom', taxRate: 5 });
    const input = screen.getByLabelText('カスタム税率');
    fireEvent.change(input, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith({ taxCategory: 'custom', taxRate: 7 });
  });
});
