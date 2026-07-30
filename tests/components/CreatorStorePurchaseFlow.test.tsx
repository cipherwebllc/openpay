import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStorePurchaseFlow } from '@/components/CreatorStorePurchaseFlow';

const state = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as
    | string
    | undefined,
  switchChainAsync: vi.fn(),
  signIn: vi.fn(),
  prepare: vi.fn(),
  purchase: vi.fn(),
  retry: vi.fn(),
  reset: vi.fn(),
  phase: 'review',
  paymentStatus: 'not-started',
  accessStatus: 'none',
  quote: {
    chainId: 80002,
    merchantValueJpyc: '100',
    feeValueJpyc: '1',
    totalValueJpyc: '101',
  } as Record<string, unknown> | null,
  content: null as Record<string, unknown> | null,
  error: null as Error | null,
  isWrongChain: false,
  canRetrySignedPayment: false,
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address }),
  useSwitchChain: () => ({
    switchChainAsync: state.switchChainAsync,
    isPending: false,
  }),
}));

vi.mock('@/components/ConnectButton', () => ({
  // jsdom で wagmi ConnectButton を実 render すると OOM (PaymentForm の既知教訓)。
  ConnectButton: () => <button type="button">接続</button>,
}));

vi.mock('@/hooks/useStoreCacheScope', () => ({
  // scope hook は wagmi/QueryClient に依存するため component テストでは no-op (専用テストで検証)
  useStoreCacheScope: () => {},
}));

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: true,
    mismatch: false,
    sessionAddress: state.address,
    signIn: state.signIn,
    isSigningIn: false,
    signInError: null,
  }),
}));

vi.mock('@/hooks/useHostedStorePurchase', () => ({
  useHostedStorePurchase: () => ({
    phase: state.phase,
    paymentStatus: state.paymentStatus,
    accessStatus: state.accessStatus,
    quote: state.quote,
    content: state.content,
    txHash: null,
    needsSupportReason: null,
    error: state.error,
    requiredChainId: state.quote ? 80002 : null,
    isWrongChain: state.isWrongChain,
    isBusy: false,
    canRetrySignedPayment: state.canRetrySignedPayment,
    prepare: state.prepare,
    purchase: state.purchase,
    retry: state.retry,
    reset: state.reset,
  }),
}));

vi.mock('@/lib/x402/hostedPurchaseWire', () => ({
  buildHostedPurchaseSignPreview: () => ({ preview: true }),
}));

vi.mock('@/components/CreatorStorePurchaseConfirmation', () => ({
  CreatorStorePurchaseConfirmation: ({
    priceJpyc,
    feeJpyc,
    totalJpyc,
    sellerDisclosureHref,
    onBack,
    onConfirm,
  }: {
    priceJpyc: string;
    feeJpyc: string;
    totalJpyc: string;
    sellerDisclosureHref: string;
    onBack: () => void;
    onConfirm: () => void;
  }) => (
    <div data-testid="confirmation">
      <span>{`${priceJpyc}/${feeJpyc}/${totalJpyc}`}</span>
      <a href={sellerDisclosureHref}>seller</a>
      <button type="button" onClick={onBack}>
        back
      </button>
      <button type="button" onClick={onConfirm}>
        confirm
      </button>
    </div>
  ),
}));

vi.mock('@/components/CreatorStorePurchaseState', () => ({
  CreatorStorePurchaseState: ({
    ownershipReadBack,
    libraryHref,
  }: {
    ownershipReadBack: boolean;
    libraryHref: string;
  }) => (
    <div data-testid="purchase-state">
      {ownershipReadBack ? 'owned' : 'not-owned'}
      <a href={libraryHref}>library</a>
    </div>
  ),
}));

const PRODUCT = {
  id: `h_${'a'.repeat(32)}`,
  title: 'Prompt',
  priceJpyc: '100',
  merchant: '0x2222222222222222222222222222222222222222' as const,
};

function renderFlow(locale: 'ja' | 'en' = 'ja') {
  return renderWithIntl(
    <CreatorStorePurchaseFlow
      open
      product={PRODUCT}
      sellerDisclosureHref={`/${locale}/store/seller/0xseller`}
      onClose={vi.fn()}
    />,
    { locale },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.address = '0x1111111111111111111111111111111111111111';
  state.phase = 'review';
  state.paymentStatus = 'not-started';
  state.accessStatus = 'none';
  state.quote = {
    chainId: 80002,
    merchantValueJpyc: '100',
    feeValueJpyc: '1',
    totalValueJpyc: '101',
  };
  state.content = null;
  state.error = null;
  state.isWrongChain = false;
  state.canRetrySignedPayment = false;
  state.switchChainAsync.mockResolvedValue(undefined);
  state.purchase.mockResolvedValue(undefined);
  state.retry.mockResolvedValue(undefined);
});

describe('CreatorStorePurchaseFlow', () => {
  it('wallet 未接続時は接続ボタンをフロー内に表示する (ヘッダーなしプロフ対応)', () => {
    state.address = undefined;
    state.phase = 'idle';
    state.quote = null;
    renderFlow();
    expect(
      screen.getByText('購入するには、ウォレットを接続してください。'),
    ).toBeInTheDocument();
    // @handle プロフはヘッダーを持たないため、モーダル内の ConnectButton が唯一の接続導線。
    expect(screen.getByRole('button', { name: '接続' })).toBeInTheDocument();
  });

  it('検証済み quote を最終確認へ渡し、確定操作でのみ purchase を呼ぶ', () => {
    renderFlow();

    expect(screen.getByTestId('confirmation')).toHaveTextContent(
      '100/1/101',
    );
    expect(screen.getByRole('link', { name: 'seller' })).toHaveAttribute(
      'href',
      '/ja/store/seller/0xseller',
    );
    expect(state.purchase).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(state.purchase).toHaveBeenCalledOnce();
  });

  it('wallet chain 不一致では最終確認を出さず Polygon 切替を先に求める', () => {
    state.isWrongChain = true;
    renderFlow();

    expect(screen.queryByTestId('confirmation')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Polygon に切り替える' }),
    );
    expect(state.switchChainAsync).toHaveBeenCalledWith({
      chainId: 80002,
    });
    expect(state.purchase).not.toHaveBeenCalled();
  });

  it('own content read-back 済みの ready だけ ownershipReadBack=true を渡す', () => {
    state.phase = 'ready';
    state.paymentStatus = 'confirmed';
    state.accessStatus = 'ready';
    state.content = { state: 'ready', value: 'secret' };
    renderFlow();

    expect(screen.getByTestId('purchase-state')).toHaveTextContent('owned');
    expect(screen.getByRole('link', { name: 'library' })).toHaveAttribute(
      'href',
      '/ja/store/library',
    );
  });

  it('indeterminate の再送は hook の同一署名 retry だけを呼ぶ', () => {
    state.phase = 'indeterminate';
    state.paymentStatus = 'unknown';
    state.accessStatus = 'provisioning';
    state.canRetrySignedPayment = true;
    renderFlow();

    fireEvent.click(
      screen.getByRole('button', {
        name: '同じ署名で再送する（再署名しない）',
      }),
    );
    expect(state.retry).toHaveBeenCalledOnce();
    expect(state.purchase).not.toHaveBeenCalled();
  });
});
