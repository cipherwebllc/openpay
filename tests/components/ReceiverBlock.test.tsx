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

import {
  ReceiverBlock,
  type ReceiverBlockProps,
} from '@/components/ReceiverBlock';
import { JPYC_CHAINS } from '@/lib/chains';

type EditableP = Extract<ReceiverBlockProps, { mode: 'editable' }>;
type ReadonlyP = Extract<ReceiverBlockProps, { mode: 'readonly' }>;

const EDITABLE_LABELS: EditableP['labels'] = {
  receiver: '受取先',
  currency: '通貨',
  chain: 'チェーン',
  useConnectedWallet: '接続中のウォレットを使う',
  receiverMatchesWallet: '接続ウォレット＝受取先',
  addressInvalid: 'アドレスが正しくありません。',
};

const READONLY_LABELS: ReadonlyP['labels'] = {
  receiver: '受取先',
  currency: '通貨',
  receiverMatchesWallet: '接続ウォレット＝受取先',
  inheritedNote: '決済QRから継承',
  changeLink: '決済QRで変更',
};

function editableProps(over: Partial<EditableP> = {}): EditableP {
  return {
    mode: 'editable',
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
    labels: EDITABLE_LABELS,
    ...over,
  };
}

function readonlyProps(over: Partial<ReadonlyP> = {}): ReadonlyP {
  return {
    mode: 'readonly',
    receiver: '',
    wallet: { matches: false },
    token: 'jpyc',
    chain: 'polygon',
    labels: READONLY_LABELS,
    ...over,
  };
}

describe('ReceiverBlock', () => {
  it('editable: TokenChooser を出し、通貨クリックで onTokenChange を委譲する', async () => {
    const user = userEvent.setup();
    const onTokenChange = vi.fn();
    render(<ReceiverBlock {...editableProps({ onTokenChange })} />);
    await user.click(screen.getByRole('button', { name: /USDC/ }));
    expect(onTokenChange).toHaveBeenCalledWith('usdc');
  });

  it('readonly: 通貨/チェーンをバッジ表示し、変更リンクで onEditCurrency。選択 UI は出ない', async () => {
    const user = userEvent.setup();
    const onEditCurrency = vi.fn();
    render(<ReceiverBlock {...readonlyProps({ onEditCurrency })} />);
    expect(screen.getByText(/JPYC/)).toBeInTheDocument();
    // editable の TokenChooser ボタン (USDC) は readonly では出ない。
    expect(screen.queryByRole('button', { name: /USDC/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '決済QRで変更' }));
    expect(onEditCurrency).toHaveBeenCalled();
  });

  it('readonly: 受取先を静的バッジ表示 (AddressInput を出さない) + advancedSummary slot', () => {
    render(
      <ReceiverBlock
        {...readonlyProps({
          receiver: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          advancedSummary: <span>決済設定: ガスレス決済</span>,
          onEditCurrency: vi.fn(),
        })}
      />,
    );
    // 受取先は短縮静的表示 (編集 input は無い)。
    expect(screen.getByText(/0x8335.*2913/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/0x\.\.\./)).toBeNull();
    // advancedSummary slot が描画される。
    expect(screen.getByText('決済設定: ガスレス決済')).toBeInTheDocument();
  });

  it('editable wallet.canUse → 「接続中のウォレットを使う」チップ', () => {
    render(
      <ReceiverBlock
        {...editableProps({ wallet: { canUse: true, matches: false, onUse: vi.fn() } })}
      />,
    );
    expect(screen.getByText('接続中のウォレットを使う')).toBeInTheDocument();
  });

  it('editable wallet.matches → 「接続ウォレット＝受取先」一致バッジ', () => {
    render(
      <ReceiverBlock
        {...editableProps({ wallet: { canUse: false, matches: true, onUse: vi.fn() } })}
      />,
    );
    expect(screen.getByText('接続ウォレット＝受取先')).toBeInTheDocument();
  });

  it('editable showAddressInvalid → 受取先 Field に注意文を描画する', () => {
    render(<ReceiverBlock {...editableProps({ showAddressInvalid: true })} />);
    expect(screen.getByText('アドレスが正しくありません。')).toBeInTheDocument();
  });
});
