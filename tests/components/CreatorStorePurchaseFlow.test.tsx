import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../_helpers/i18n';
import {
  CreatorStorePurchaseFlow,
  type CreatorStorePurchaseFlowProps,
} from '@/components/CreatorStorePurchaseFlow';

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
  licenseEnabled: false,
  sellerRole: undefined as 'operator' | 'third_party' | undefined,
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
  isBusy: false,
  signPreview: { preview: true } as Record<string, unknown> | null,
  canRetrySignedPayment: false,
  hookInput: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableLicenseNftUi() { return state.licenseEnabled; } } };
});

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
  useHostedStorePurchase: (input: Record<string, unknown>) => {
    state.hookInput = input;
    return {
    phase: state.phase,
    paymentStatus: state.paymentStatus,
    accessStatus: state.accessStatus,
    quote: state.quote,
    sellerRole: state.sellerRole,
    content: state.content,
    txHash: null,
    needsSupportReason: null,
    error: state.error,
    requiredChainId: state.quote ? Number(state.quote.chainId) : null,
    isWrongChain: state.isWrongChain,
    isBusy: state.isBusy,
    canRetrySignedPayment: state.canRetrySignedPayment,
    prepare: state.prepare,
    purchase: state.purchase,
    retry: state.retry,
    reset: state.reset,
    };
  },
}));

vi.mock('@/lib/x402/hostedPurchaseWire', () => ({
  // start 画面の合計表示が使う実式 (max(1JPYC,1%)) を最小再現 (掟 6)。
  hostedPurchaseFeeValue: (v: bigint) => {
    const pct = (v * 100n) / 10_000n;
    const floor = 10n ** 18n;
    return pct > floor ? pct : floor;
  },
  buildHostedPurchaseSignPreview: () => state.signPreview,
}));

vi.mock('@/components/CreatorStorePurchaseConfirmation', () => ({
  CreatorStorePurchaseConfirmation: ({
    product,
    priceJpyc,
    feeJpyc,
    totalJpyc,
    rail,
    paidUsdc,
    sellerDisclosureHref,
    isSubmitting,
    onBack,
    onConfirm,
  }: {
    product?: { sellerRole?: string };
    priceJpyc: string;
    feeJpyc: string;
    totalJpyc: string;
    rail?: 'jpyc' | 'usdc';
    paidUsdc?: string;
    sellerDisclosureHref: string;
    isSubmitting?: boolean;
    onBack: () => void;
    onConfirm: () => void;
  }) => (
    <div data-testid="confirmation" data-seller-role={product?.sellerRole}>
      <span>
        {rail === 'usdc'
          ? `usdc:${priceJpyc}/${paidUsdc}`
          : `${priceJpyc}/${feeJpyc}/${totalJpyc}`}
      </span>
      <a href={sellerDisclosureHref}>seller</a>
      <button type="button" onClick={onBack}>
        back
      </button>
      <button type="button" disabled={isSubmitting} onClick={onConfirm}>
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

function renderFlow(
  locale: 'ja' | 'en' = 'ja',
  product: CreatorStorePurchaseFlowProps['product'] = PRODUCT,
) {
  return renderWithIntl(
    <CreatorStorePurchaseFlow
      open
      product={product}
      sellerDisclosureHref={`/${locale}/store/seller/0xseller`}
      onClose={vi.fn()}
    />,
    { locale },
  );
}

beforeEach(() => {
  state.licenseEnabled = false;
  state.sellerRole = undefined;
  vi.clearAllMocks();
  state.address = '0x1111111111111111111111111111111111111111';
  state.phase = 'review';
  state.paymentStatus = 'not-started';
  state.accessStatus = 'none';
  state.quote = {
    rail: 'jpyc',
    chainId: 80002,
    merchantValueJpyc: '100',
    feeValueJpyc: '1',
    totalValueJpyc: '101',
  };
  state.content = null;
  state.error = null;
  state.isWrongChain = false;
  state.isBusy = false;
  state.signPreview = { preview: true };
  state.canRetrySignedPayment = false;
  state.hookInput = null;
  state.switchChainAsync.mockResolvedValue(undefined);
  state.purchase.mockResolvedValue(undefined);
  state.retry.mockResolvedValue(undefined);
});

describe('CreatorStorePurchaseFlow', () => {
  it.each(['ja', 'en'] as const)('表示詳細はプレーンテキスト・仕様表・外部リンクとして表示する (%s)', (locale) => {
    state.phase = 'idle';
    state.quote = null;
    const details = '<b>内容物</b>\n' + '詳しい説明。'.repeat(250);
    const { container } = renderFlow(locale, { ...PRODUCT, details,
      specs: [{ label: '形式', value: 'GLB' }, { label: 'サイズ', value: '12 MB' }],
      demoUrl: 'https://example.com/demo',
    });
    const description = screen.getByText(/<b>内容物<\/b>/);
    expect(description.textContent).toBe(details);
    expect(description).toHaveClass('whitespace-pre-line', 'break-words');
    expect(description.querySelector('b')).toBeNull();
    expect(screen.getByRole('heading', { name: locale === 'ja' ? '仕様' : 'Specifications' })).toBeVisible();
    const specs = container.querySelector('dl')!;
    expect([...specs.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['形式', 'サイズ']);
    expect([...specs.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['GLB', '12 MB']);
    // 遷移先を読めるよう、ボタンにホスト名を併記する
    const link = screen.getByRole('link', { name: locale === 'ja' ? /^実際に試す/ : /^Try it out/ });
    expect(link).toHaveTextContent('example.com');
    expect(link).toHaveAttribute('href', 'https://example.com/demo');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link).toHaveTextContent('↗');
    expect(state.hookInput).not.toHaveProperty('details');
    expect(state.hookInput).not.toHaveProperty('specs');
    expect(state.hookInput).not.toHaveProperty('demoUrl');
  });

  it('詳細未設定の商品には空の詳細欄・仕様表・デモリンクを出さない', () => {
    state.phase = 'idle';
    state.quote = null;
    const { container } = renderFlow();
    expect(container.querySelector('.whitespace-pre-line')).toBeNull();
    expect(container.querySelector('dl')).toBeNull();
    expect(screen.queryByRole('heading', { name: '仕様' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '実際に試す' })).not.toBeInTheDocument();
  });

  it('開始画面でメイン画像を表示し、サムネイルで切替・読込失敗時に fallback する', () => {
    state.phase = 'idle';
    state.quote = null;
    const imageUrl = 'https://cdn.example.com/product.png';
    const duplicateGalleryUrl = 'https://cdn.example.com/product-side.png';
    const galleryUrls = [
      duplicateGalleryUrl,
      duplicateGalleryUrl,
    ];
    const { container } = renderFlow('ja', {
      ...PRODUCT,
      imageUrl,
      galleryUrls,
    });

    const largeImage = () =>
      container.querySelector<HTMLImageElement>('img.max-h-80');
    expect(largeImage()).toHaveAttribute('src', imageUrl);
    expect(largeImage()).toHaveAttribute('alt', '');
    expect(largeImage()).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const secondThumbnail = screen.getByRole('button', { name: '2' });
    fireEvent.click(secondThumbnail);

    expect(largeImage()).toHaveAttribute('src', galleryUrls[0]);
    expect(secondThumbnail).toHaveAttribute('aria-pressed', 'true');
    expect(secondThumbnail).toHaveClass('ring-2');

    fireEvent.error(largeImage()!);

    expect(screen.queryByRole('button', { name: '2' })).toBeNull();
    // 同じ URL の別 index は巻き込まず、失敗したサムネイルだけを除外する。
    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument();
    expect(largeImage()).toHaveAttribute('src', imageUrl);
    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('ギャラリー画像: DOM・サムネ失敗で親の選択が次へ移る・外れた node の遅れ error・大画像の失敗 (R7a の網)', () => {
    state.phase = 'idle';
    state.quote = null;
    const urls = ['https://images.example/a.png', 'https://images.example/b.png', 'https://images.example/c.png'];
    const { container } = renderFlow('ja', { ...PRODUCT, imageUrl: urls[0], galleryUrls: urls.slice(1) });
    const large = container.querySelector('img.max-h-80')!;
    expect(large.outerHTML).toBe(`<img alt="" aria-hidden="true" width="640" height="360" referrerpolicy="no-referrer" class="aspect-[16/9] max-h-80 w-full bg-slate-100 object-cover" src="${urls[0]}">`);
    const firstButton = screen.getByRole('button', { name: '1' });
    const firstThumb = firstButton.querySelector('img')!;
    expect(firstButton.innerHTML).toBe(`<img alt="" aria-hidden="true" width="48" height="48" referrerpolicy="no-referrer" loading="lazy" class="h-12 w-12 rounded-lg object-cover" src="${urls[0]}"><span class="mt-0.5 block text-center text-[10px] font-bold">1</span>`);
    expect(large.nextElementSibling).toHaveAttribute('role', 'group');
    expect(large.nextElementSibling).toHaveAttribute('aria-labelledby', 'creator-store-purchase-product-title');
    fireEvent.error(firstThumb);
    expect(large).toHaveAttribute('src', urls[1]);
    expect(screen.queryByRole('button', { name: '1' })).toBeNull();
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.error(firstThumb); // 選択が B へ移った後に、外れた A のサムネへ遅れて error が届く。
    expect(large).toHaveAttribute('src', urls[1]);
    const thirdButton = screen.getByRole('button', { name: '3' });
    expect(thirdButton.className).toBe('rounded-xl border bg-white p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40 border-slate-200 text-slate-500 hover:border-slate-300');
    fireEvent.click(thirdButton);
    expect(container.querySelector('img.max-h-80')).toBe(large);
    expect(large).toHaveAttribute('src', urls[2]);
    expect(thirdButton.className).toBe('rounded-xl border bg-white p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40 border-brand text-brand-dark ring-2 ring-brand/30');
    fireEvent.error(large);
    expect(large).toHaveAttribute('src', urls[1]);
    expect(screen.queryByRole('button', { name: '2' })).toBeNull(); // 残り 1 枚ならサムネ列を出さない。
    fireEvent.error(large);
    expect(container.querySelector('img.max-h-80')).toBeNull();
  });

  it('imageUrl がなければギャラリー先頭を大きく表示し、1 枚ではサムネイルを出さない', () => {
    state.phase = 'idle';
    state.quote = null;
    const galleryUrl = 'https://cdn.example.com/product-side.png';
    const { container } = renderFlow('ja', {
      ...PRODUCT,
      galleryUrls: [galleryUrl],
    });

    expect(
      container.querySelector<HTMLImageElement>('img.max-h-80'),
    ).toHaveAttribute('src', galleryUrl);
    expect(screen.queryByRole('button', { name: '1' })).toBeNull();
  });

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

  it('usdcEnabled=true の modal 内だけ JPYC 既定の支払い方法選択を表示する', () => {
    state.phase = 'idle';
    state.quote = null;
    const { rerender } = renderFlow('ja', {
      ...PRODUCT,
      usdcEnabled: true,
    });

    const jpyc = screen.getByRole('radio', { name: /JPYC で支払う/ });
    const usdc = screen.getByRole('radio', { name: /USDC で支払う/ });
    expect(jpyc).toBeChecked();
    expect(usdc).not.toBeChecked();
    expect(state.hookInput).toMatchObject({
      title: PRODUCT.title,
      rail: 'jpyc',
    });

    fireEvent.click(usdc);
    rerender(
      <CreatorStorePurchaseFlow
        open
        product={{ ...PRODUCT, usdcEnabled: true }}
        sellerDisclosureHref="/ja/store/seller/0xseller"
        onClose={vi.fn()}
      />,
    );
    expect(usdc).toBeChecked();
    expect(state.hookInput).toMatchObject({ rail: 'usdc' });
    expect(screen.getByText('商品価格 100 JPYC')).toBeInTheDocument();
  });

  it('単一レール商品では支払い方法選択を表示しない', () => {
    state.phase = 'idle';
    state.quote = null;
    renderFlow();
    expect(screen.queryByText('支払い方法')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(state.hookInput).toMatchObject({ rail: 'jpyc' });
  });

  it('USDC quote は実払額と JPYC 商品価格を最終確認へ渡す', () => {
    state.quote = {
      rail: 'usdc',
      chainId: 8453,
      priceJpyc: '100',
      paidUsdc: '0.67',
      merchant: PRODUCT.merchant,
      payment: {
        quote: {
          rateScaled: '150000000',
          rateFetchedAt: 1_800_000_000_000,
          fxQuoteExpiresAt: 1_800_000_180_000,
        },
      },
    };
    renderFlow('ja', { ...PRODUCT, usdcEnabled: true });
    expect(screen.getByTestId('confirmation')).toHaveTextContent(
      'usdc:100/0.67',
    );
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

  // B-R15d: 署名中・送信中に start view へ落ちると rail/prepare が押せ、進行中の購入を捨てて
  // 2 回目の署名へ進めてしまう。wrong chain でも確認 UI を保ち、操作を止める。
  it.each(['signing', 'submitting'] as const)(
    '%s 中に wallet の chain が変わっても最終確認を出し続け、確定・支払い方法・購入内容の確認は押せない',
    (phase) => {
      state.phase = phase;
      state.isWrongChain = true;
      state.isBusy = true;
      renderFlow('ja', { ...PRODUCT, usdcEnabled: true });

      expect(screen.getByTestId('confirmation')).toHaveTextContent('100/1/101');
      expect(screen.getByRole('button', { name: 'confirm' })).toBeDisabled();
      expect(screen.queryByRole('radio')).toBeNull();
      expect(
        screen.queryByRole('button', { name: '購入内容を確認する' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Polygon に切り替える' }),
      ).toBeNull();
      expect(state.prepare).not.toHaveBeenCalled();
    },
  );

  it('署名中に最終確認を描けない場合 (sign preview なし) も、支払い方法と購入内容の確認は押せない', () => {
    state.phase = 'signing';
    state.isBusy = true;
    state.signPreview = null;
    renderFlow('ja', { ...PRODUCT, usdcEnabled: true });

    expect(screen.queryByTestId('confirmation')).toBeNull();
    expect(screen.getByRole('radio', { name: /JPYC で支払う/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /USDC で支払う/ })).toBeDisabled();
    const prepareButton = screen.getByRole('button', {
      name: '購入内容を確認する',
    });
    expect(prepareButton).toBeDisabled();
    fireEvent.click(prepareButton);
    expect(state.prepare).not.toHaveBeenCalled();
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


describe('license purchase flow', () => {
  const licenseProduct = { ...PRODUCT, productKind: 'license' as const, priceJpyc: '1000', license: { supply: 10, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1' } };
  it('最終確認は server quote の sellerRole を受け取る', () => {
    state.licenseEnabled = true;
    state.sellerRole = 'third_party';
    renderFlow('ja', { ...licenseProduct, sellerRole: 'operator', sellerName: 'Seller' });
    expect(screen.getByTestId('confirmation')).toHaveAttribute('data-seller-role', 'third_party');
    expect(state.hookInput).not.toHaveProperty('sellerRole');
  });
  it.each([
    ['sold_out', '完売しました'],
    ['reservation_quota', '同時に確保できる数の上限です。しばらくしてからお試しください'],
    ['recipient_unsupported', 'このウォレットは NFT を受け取れません。対応するウォレットをご利用ください。'],
    ['license_registration_pending', '準備中です'],
    ['license_simulation_unavailable', '確認できませんでした。時間をおいて再試行'],
  ])('%s は可視の購入エラーになる', (code, message) => {
    state.licenseEnabled = true; state.phase = 'error'; state.quote = null; state.error = new Error(code);
    renderFlow('ja', licenseProduct);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByText('利用ライセンス NFT')).toBeInTheDocument();
  });
  it('署名送信後の確定エラーも表示する', () => {
    state.licenseEnabled = true; state.phase = 'failed-prebroadcast'; state.error = new Error('sold_out');
    renderFlow('ja', licenseProduct);
    expect(screen.getByRole('alert')).toHaveTextContent('完売しました');
  });
  it('flag OFF ではライセンス modal を表示しない', () => {
    const { container } = renderFlow('ja', licenseProduct);
    expect(container).toBeEmptyDOMElement();
  });
});

it.each(['ja', 'en'] as const)('%s: product modal renders a configured delivery badge', (locale) => {
  state.phase = 'idle'; state.quote = null;
  renderFlow(locale, { ...PRODUCT, protectedDelivery: true });
  expect(screen.getByText(locale === 'ja' ? '保護配布' : 'Protected delivery', { exact: true })).toBeVisible();
});
