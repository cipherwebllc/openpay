import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '../_helpers/i18n';
import userEvent from '@testing-library/user-event';

// AddressInput 内の useResolveAddress (外 RPC) はテストで通信を発生させないため mock。
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: vi.fn(() => ({
    data: null,
    isFetching: false,
    error: null,
  })),
}));

import { ReceiverBlock } from '@/components/ReceiverBlock';
import { JPYC_CHAINS } from '@/lib/chains';

const LABELS = {
  receiver: '受取先',
  currency: '通貨',
  chain: 'チェーン',
  useConnectedWallet: '接続中のウォレットを使う',
  receiverMatchesWallet: '接続ウォレット＝受取先',
  addressInvalid: 'アドレスが正しくありません。',
  inheritedNote: '決済QRから継承',
  changeLink: '決済QRで変更',
};

function props(
  over: Partial<Parameters<typeof ReceiverBlock>[0]> = {},
): Parameters<typeof ReceiverBlock>[0] {
  return {
    receiver: '',
    onReceiverChange: vi.fn(),
    onResolved: vi.fn(),
    showAddressInvalid: false,
    wallet: { canUse: false, matches: false, onUse: vi.fn() },
    token: 'jpyc',
    chain: 'polygon',
    availableChains: JPYC_CHAINS,
    onTokenChange: vi.fn(),
    onChainChange: vi.fn(),
    currencyMode: 'editable',
    labels: LABELS,
    ...over,
  };
}

describe('ReceiverBlock', () => {
  it('editable: TokenChooser を出し、通貨クリックで onTokenChange を委譲する', async () => {
    const user = userEvent.setup();
    const onTokenChange = vi.fn();
    render(<ReceiverBlock {...props({ onTokenChange })} />);
    await user.click(screen.getByRole('button', { name: /USDC/ }));
    expect(onTokenChange).toHaveBeenCalledWith('usdc');
  });

  it('readonly: 通貨/チェーンをバッジ表示し、変更リンクで onEditCurrency。選択 UI は出ない', async () => {
    const user = userEvent.setup();
    const onEditCurrency = vi.fn();
    render(
      <ReceiverBlock
        {...props({ currencyMode: 'readonly', onEditCurrency })}
      />,
    );
    expect(screen.getByText(/JPYC/)).toBeInTheDocument();
    // editable の TokenChooser ボタン (USDC) は readonly では出ない。
    expect(screen.queryByRole('button', { name: /USDC/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '決済QRで変更' }));
    expect(onEditCurrency).toHaveBeenCalled();
  });

  it('wallet.canUse → 「接続中のウォレットを使う」チップ', () => {
    render(
      <ReceiverBlock
        {...props({ wallet: { canUse: true, matches: false, onUse: vi.fn() } })}
      />,
    );
    expect(screen.getByText('接続中のウォレットを使う')).toBeInTheDocument();
  });

  it('wallet.matches → 「接続ウォレット＝受取先」一致バッジ', () => {
    render(
      <ReceiverBlock
        {...props({ wallet: { canUse: false, matches: true, onUse: vi.fn() } })}
      />,
    );
    expect(screen.getByText('接続ウォレット＝受取先')).toBeInTheDocument();
  });

  it('showAddressInvalid + receiverExtra を受取先 Field に描画する', () => {
    render(
      <ReceiverBlock
        {...props({
          showAddressInvalid: true,
          receiverExtra: <span>EXTRA-LINK</span>,
        })}
      />,
    );
    expect(screen.getByText('アドレスが正しくありません。')).toBeInTheDocument();
    expect(screen.getByText('EXTRA-LINK')).toBeInTheDocument();
  });
});
