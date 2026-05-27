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

  it('nativeToken がバナー本文に含まれる', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={DELEGATE}
        nativeToken="POL"
        canFallbackToStandard
        onSwitchToStandard={vi.fn()}
      />,
    );
    expect(screen.getByText(/POL/)).toBeInTheDocument();
  });

  it('tip banner では nativeToken は本文に含まれない', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={DELEGATE}
        nativeToken="KAIA"
        canFallbackToStandard={false}
      />,
    );
    // tipOnlyBody には nativeToken placeholder が無い
    expect(screen.getByText(/チップを送れません/)).toBeInTheDocument();
  });
});

describe('SmartAccountFallbackBanner (reason=pristine: 未委任 EOA)', () => {
  it('pristine + 切替可 → pristine 文言・切替ボタンあり、incompatible 文言や address は出さない', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={null}
        nativeToken="ETH"
        reason="pristine"
        canFallbackToStandard
        onSwitchToStandard={vi.fn()}
      />,
    );
    // pristine タイトル/本文 (同一フレーズが両方に出るので getAllByText)
    expect(
      screen.getAllByText(/ガスレス決済の準備ができていません/).length,
    ).toBeGreaterThanOrEqual(1);
    // incompatible (delegate 委任済み) 用の文言は出さない
    expect(screen.queryByText(/未対応の Smart Account/)).not.toBeInTheDocument();
    // delegate 不在なので address (unknown) も参照しない
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
    // standard 導線の native token は本文に出る
    expect(screen.getByText(/ETH/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /通常決済に切替/ }),
    ).toBeInTheDocument();
  });

  it('pristine + tip (切替不可) → pristine tip 本文・ボタン無し・address 参照無し', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={null}
        nativeToken="POL"
        reason="pristine"
        canFallbackToStandard={false}
      />,
    );
    expect(
      screen.getAllByText(/ガスレス決済の準備ができていません/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/チップ送信にはガスレスモードが必要/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
  });

  it('reason 未指定の default は incompatible (未対応 Smart Account 文言)', () => {
    render(
      <SmartAccountFallbackBanner
        delegateAddress={DELEGATE}
        nativeToken="ETH"
        canFallbackToStandard
        onSwitchToStandard={vi.fn()}
      />,
    );
    expect(screen.getByText(/未対応の Smart Account/)).toBeInTheDocument();
    expect(
      screen.queryByText(/ガスレス決済の準備ができていません/),
    ).not.toBeInTheDocument();
  });
});
