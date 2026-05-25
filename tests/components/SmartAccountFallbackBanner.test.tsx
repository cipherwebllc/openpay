import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '../_helpers/i18n';
import { SmartAccountFallbackBanner } from '@/components/SmartAccountFallbackBanner';

const DELEGATE = '0x470a5773112931D5f35318BE1eD0B9Fdc916bf19' as const;

describe('SmartAccountFallbackBanner', () => {
  it('canFallbackToStandard=true → 切替ボタンが表示される', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={DELEGATE}
        nativeToken="KAIA"
        canFallbackToStandard
        onSwitchToStandard={vi.fn()}
      />,
    );
    expect(screen.getByText(/未対応の Smart Account/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /通常決済に切替/ })).toBeInTheDocument();
    expect(screen.getByText(/0x470a…bf19/)).toBeInTheDocument();
  });

  it('canFallbackToStandard=false → 切替ボタン非表示、tip 案内が出る', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={DELEGATE}
        nativeToken="KAIA"
        canFallbackToStandard={false}
      />,
    );
    expect(screen.getByText(/未対応の Smart Account/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/チップを送れません/)).toBeInTheDocument();
  });

  it('切替ボタンクリックで onSwitchToStandard が呼ばれる', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    render(
      <SmartAccountFallbackBanner
        delegateAddress={DELEGATE}
        nativeToken="POL"
        canFallbackToStandard
        onSwitchToStandard={onSwitch}
      />,
    );
    await user.click(screen.getByRole('button', { name: /通常決済に切替/ }));
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it('delegateAddress が null のとき unknown と表示', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={null}
        nativeToken="ETH"
        canFallbackToStandard
        onSwitchToStandard={vi.fn()}
      />,
    );
    expect(screen.getByText(/unknown/)).toBeInTheDocument();
  });
});
