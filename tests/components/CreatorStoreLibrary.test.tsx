import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStoreLibrary } from '@/components/CreatorStoreLibrary';

const ADDRESS = '0x1234567890123456789012345678901234567890';
const state = vi.hoisted(() => ({
  sessionAddress: '0x1234567890123456789012345678901234567890' as
    | string
    | null,
  isSignedIn: true,
  licenseEnabled: false,
  deliveryEnabled: false,
}));

vi.mock('@/lib/env', () => ({
  env: { enableCreatorStoreUi: true, networkEnv: 'mainnet', get enableStoreDeliveryTicketUi() { return state.deliveryEnabled; }, get enableLicenseNftUi() { return state.licenseEnabled; } },
}));

vi.mock('@/hooks/useStoreCacheScope', () => ({
  // scope hook は wagmi/QueryClient に依存するため component テストでは no-op (専用テストで検証)
  useStoreCacheScope: () => {},
}));

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: state.isSignedIn,
    mismatch: false,
    isLoading: false,
    sessionAddress: state.sessionAddress,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderLibrary(queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
}), source: 'purchases' | 'holders' = 'purchases') {
  return {
    queryClient,
    ...renderWithIntl(
      <QueryClientProvider client={queryClient}>
        <CreatorStoreLibrary source={source} />
      </QueryClientProvider>,
    ),
  };
}

describe('CreatorStoreLibrary', () => {
  beforeEach(() => {
    state.sessionAddress = ADDRESS;
    state.licenseEnabled = false;
    state.isSignedIn = true;
    vi.restoreAllMocks();
  });

  it('sessionAddress を含む query で一覧を読み、content API の ready 内容を表示する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/store/library') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            items: [
              {
                resourceId: 'h_product-a',
                title: '購入済みプロンプト',
                desc: '説明',
                emoji: '🧭',
                priceJpyc: '300',
                contentKind: 'text',
                label: 'prompt',
                purchasedAt: 1_750_000_000_000,
                contentRevision: 2,
                payment: {
                  version: 1,
                  rail: 'usdc',
                  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                  assetSymbol: 'USDC',
                  chainId: 8453,
                  paidAtomic: '2000000',
                  priceJpyc: '300',
                  quote: {
                    rateScaled: '150000000',
                    rateFetchedAt: 1_749_999_900_000,
                    fxQuoteExpiresAt: 1_750_000_080_000,
                    rounding: 'ceil',
                  },
                },
                revisions: [
                  {
                    title: '購入済みプロンプト',
                    desc: '説明',
                    emoji: '🧭',
                    priceJpyc: '300',
                    contentKind: 'text',
                    label: 'prompt',
                    purchasedAt: 1_750_000_000_000,
                    contentRevision: 2,
                    payment: {
                      version: 1,
                      rail: 'usdc',
                      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                      assetSymbol: 'USDC',
                      chainId: 8453,
                      paidAtomic: '2000000',
                      priceJpyc: '300',
                      quote: {
                        rateScaled: '150000000',
                        rateFetchedAt: 1_749_999_900_000,
                        fxQuoteExpiresAt: 1_750_000_080_000,
                        rounding: 'ceil',
                      },
                    },
                  },
                  {
                    title: '購入済みプロンプト旧版',
                    priceJpyc: '250',
                    contentKind: 'text',
                    label: 'prompt',
                    purchasedAt: 1_740_000_000_000,
                    contentRevision: 1,
                  },
                ],
              },
            ],
            nextCursor: null,
          }),
        );
      }
      if (url === '/api/store/content/h_product-a?revision=1') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'ready',
            resourceId: 'h_product-a',
            title: '購入済みプロンプト旧版',
            contentRevision: 1,
            intentSalt: `0x${'a'.repeat(64)}`,
            purchasedAt: 1_700_000_000_000,
            txHash: `0x${'ab'.repeat(32)}`,
            kind: 'text',
            value: '購入時 revision の本文',
          }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: false, error: 'not_found' }, 404));
    });
    const { queryClient } = renderLibrary();

    expect(await screen.findByText('購入済みプロンプト')).toBeInTheDocument();
    expect(
      queryClient.getQueryState(['store', 'library', ADDRESS]),
    ).toBeDefined();
    expect(screen.getByText('リビジョン 2')).toBeInTheDocument();
    expect(screen.getByText('リビジョン 1')).toBeInTheDocument();
    expect(screen.getByText('2 USDC · 300 JPYC')).toBeInTheDocument();
    expect(screen.getByText('決済スナップショット v1')).toBeInTheDocument();
    expect(screen.getByText('1 USDC = 150 JPYC')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'リビジョン 1 を表示' }),
    );
    expect(await screen.findByText('購入時 revision の本文')).toBeInTheDocument();
    // 来歴の明示 (2026-08-01 裁定): 誰宛の提供かをウォレット短縮表示で示す。
    expect(
      screen.getByText(/この商品はウォレット .*宛に提供されています/),
    ).toBeInTheDocument();
    expect(screen.getByText(/購入ID 0xaaaaaaaa/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/store/content/h_product-a?revision=1',
      {
        cache: 'no-store',
      },
    );
    expect(
      queryClient.getQueryState([
        'store',
        'content',
        ADDRESS,
        'h_product-a',
        1,
      ]),
    ).toBeDefined();
  });

  it('安定 cursor をそのまま次ページへ渡し、提供終了 state を明示する', async () => {
    const cursor = '1750000000000:h_product-a';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/store/library') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            items: [
              {
                resourceId: 'h_product-a',
                title: '商品 A',
                priceJpyc: '100',
                contentKind: 'url',
                label: 'download',
                purchasedAt: 1_750_000_000_000,
                contentRevision: 1,
                revisions: [
                  {
                    title: '商品 A',
                    priceJpyc: '100',
                    contentKind: 'url',
                    label: 'download',
                    purchasedAt: 1_750_000_000_000,
                    contentRevision: 1,
                  },
                ],
              },
            ],
            nextCursor: cursor,
          }),
        );
      }
      if (
        url ===
        `/api/store/library?cursor=${encodeURIComponent(cursor)}`
      ) {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            items: [
              {
                resourceId: 'h_product-b',
                title: '商品 B',
                priceJpyc: '200',
                contentKind: 'text',
                label: 'pdf',
                purchasedAt: 1_740_000_000_000,
                contentRevision: 3,
                revisions: [
                  {
                    title: '商品 B',
                    priceJpyc: '200',
                    contentKind: 'text',
                    label: 'pdf',
                    purchasedAt: 1_740_000_000_000,
                    contentRevision: 3,
                  },
                ],
              },
            ],
            nextCursor: null,
          }),
        );
      }
      if (url === '/api/store/content/h_product-b?revision=3') {
        return Promise.resolve(
          jsonResponse({
            ok: true,
            state: 'provided-ended',
            resourceId: 'h_product-b',
            title: '商品 B',
            contentRevision: 3,
            intentSalt: `0x${'b'.repeat(64)}`,
          }),
        );
      }
      return Promise.resolve(jsonResponse({ ok: false, error: 'not_found' }, 404));
    });
    renderLibrary();

    expect(await screen.findByText('商品 A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'さらに読み込む' }));
    expect(await screen.findByText('商品 B')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'リビジョン 3 を表示' }),
    );
    expect(await screen.findByText('提供終了')).toBeInTheDocument();
    expect(
      screen.getByText(/購入記録は残っていますが/),
    ).toBeInTheDocument();
  });
});


describe('license library', () => {
  beforeEach(() => { vi.restoreAllMocks(); state.licenseEnabled = true; state.sessionAddress = ADDRESS; state.isSignedIn = true; });
  const revision = { title: 'Purchased license', priceJpyc: '1000', contentKind: 'text', label: 'api', purchasedAt: 1_750_000_000_000, contentRevision: 1 };
  const tx = `0x${'ab'.repeat(32)}`;
  const heldItem = { resourceId: 'h_held', title: 'Incoming license', license: { supply: 10, transferable: true, termsUrl: 'https://example.com/terms', termsVersion: '1', tokenChainId: 80002 }, nft: { status: 'minted', mintTxHash: tx }, entitled: true, basis: 'holder', state: 'ready', contentRevision: 1 };
  it('source=holders で受取セクションを先頭へ表示し、同じ URL への導線を持つ', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).includes('source=holders')
      ? jsonResponse({ ok: true, items: [heldItem], nextCursor: null })
      : jsonResponse({ ok: true, items: [{ ...revision, resourceId: 'h_purchase', revisions: [revision] }], nextCursor: null }));
    renderLibrary(undefined, 'holders');
    await screen.findByText('Purchased license');
    const received = await screen.findByText('Incoming license');
    expect(received.compareDocumentPosition(screen.getByText('Purchased license')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: '受け取ったライセンスを見る' })).toHaveAttribute('href', '/ja/store/library?source=holders#creator-store-received-heading');
  });
  it.each([
    ['pending', true, 'purchase', '発行待ち'], ['minted', true, 'purchase', '発行済み'], ['needs_repair', true, 'purchase', '修復中'], ['minted', false, 'holder', '譲渡済み'], ['unknown', null, null, '確認できませんでした'],
  ])('購入履歴の %s/%s は %s 根拠で表示する', async (status, entitled, basis, label) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).includes('source=holders')
      ? jsonResponse({ ok: true, items: [], nextCursor: null })
      : jsonResponse({ ok: true, items: [{ ...revision, resourceId: 'h_purchase', revisions: [revision], productKind: 'license', tokenChainId: 137, nft: { status, mintTxHash: tx }, entitled, basis }], nextCursor: null }));
    renderLibrary();
    expect(await screen.findByText(`NFT 状態: ${label}`)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'リビジョン 1 を表示' });
    if (entitled === true) expect(button).toBeEnabled(); else expect(button).toBeDisabled();
    if (status === 'minted' && entitled === true) expect(screen.getByRole('link', { name: '発行トランザクションを見る' })).toHaveAttribute('href', `https://polygonscan.com/tx/${tx}`);
  });
  it('受取は独立の cursor で読み込み、購入履歴を作らず案内を取得する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path === '/api/store/library?source=holders') return jsonResponse({ ok: true, items: [], nextCursor: 'h_cursor' });
      if (path === '/api/store/library?source=holders&cursor=h_cursor') return jsonResponse({ ok: true, items: [heldItem], nextCursor: null });
      if (path === '/api/store/content/h_held?revision=1') return jsonResponse({ ok: true, state: 'ready', productKind: 'license', basis: 'holder', title: heldItem.title, resourceId: 'h_held', contentRevision: 1, kind: 'text', value: 'Received instructions' });
      return jsonResponse({ ok: true, items: [], nextCursor: null });
    });
    const { queryClient } = renderLibrary();
    const section = (await screen.findByRole('heading', { name: '受け取ったライセンス' })).closest('section')!;
    fireEvent.click(await within(section).findByRole('button', { name: 'さらに読み込む' }));
    await screen.findByText('Incoming license');
    expect(within(section).queryByText(/購入日時/)).not.toBeInTheDocument();
    expect(within(section).getByRole('link', { name: '発行トランザクションを見る' })).toHaveAttribute('href', `https://amoy.polygonscan.com/tx/${tx}`);
    expect(queryClient.getQueryData(['store', 'library-holders', ADDRESS])).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '利用開始の案内を開く' }));
    await screen.findByText('Received instructions');
    expect(screen.getByText('現在の NFT 保有に基づく提供です。このウォレットの購入記録ではありません。')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/store/content/h_held?revision=1', { cache: 'no-store' });
  });
  it('受取 API の不明/障害を空や購入履歴のエラーに変えない', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => String(url).includes('source=holders')
      ? jsonResponse({ ok: false, error: 'license_rights_unknown' }, 503)
      : jsonResponse({ ok: true, items: [{ ...revision, resourceId: 'h_purchase', revisions: [revision] }], nextCursor: null }));
    renderLibrary();
    await screen.findByText('Purchased license');
    expect(await screen.findByRole('alert')).toHaveTextContent('受け取ったライセンスを確認できませんでした');
    expect(screen.queryByText('受け取ったライセンスはありません。続きがある場合は読み込んでください。')).not.toBeInTheDocument();
  });
  it('flag OFF は受取 API を呼ばず、license 表示も追加しない', async () => {
    state.licenseEnabled = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, items: [], nextCursor: null }));
    renderLibrary();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('source=holders'))).toBe(false);
    expect(screen.queryByText('受け取ったライセンス')).not.toBeInTheDocument();
  });
  it('未サインインでは受取 API を呼ばない', () => {
    state.isSignedIn = false; state.sessionAddress = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch'); renderLibrary();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('受け取ったライセンス')).not.toBeInTheDocument();
  });
});


describe('protected delivery library navigation', () => {
  beforeEach(() => { state.isSignedIn = true; state.sessionAddress = ADDRESS; state.licenseEnabled = true; state.deliveryEnabled = true; vi.restoreAllMocks(); });
  const cases = (['digital', 'license', 'holder'] as const).flatMap((source) => [false, true].flatMap((enabled) => (['ready', 'provided-ended'] as const).map((contentState) => ({ source, enabled, contentState }))));
  it.each(cases)('$source $contentState flag=$enabled: only ready content exposes an ordinary issuance anchor', async ({ source, enabled, contentState }) => {
    state.deliveryEnabled = enabled;
    const href = '/api/store/delivery/h_delivery?revision=1';
    const revision = { title: 'Delivery item', priceJpyc: '1000', contentKind: 'text', label: 'download', purchasedAt: 1, contentRevision: 1 };
    const license = { productKind: 'license', nft: { status: 'minted' }, entitled: true, basis: source === 'holder' ? 'holder' : 'purchase', license: { supply: 1, transferable: true, termsUrl: 'https://example.com/terms', termsVersion: '1' } };
    const item = { ...revision, resourceId: 'h_delivery', revisions: [revision], ...(source !== 'digital' ? license : {}) };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = String(url);
      if (path.startsWith('/api/store/content/')) return jsonResponse({ ok: true, state: contentState, ...item, ...(source === 'holder' ? {} : { intentSalt: '0x1234' }), kind: 'url', value: 'https://example.com/instructions', delivery: { mode: 'ticket', href } });
      if (path.includes('source=holders')) return jsonResponse({ ok: true, items: source === 'holder' ? [{ ...item, state: 'ready' }] : [], nextCursor: null });
      return jsonResponse({ ok: true, items: source !== 'holder' ? [item] : [], nextCursor: null });
    });
    const { queryClient } = renderLibrary(undefined, source === 'holder' ? 'holders' : 'purchases');
    fireEvent.click(await screen.findByRole('button', { name: source === 'holder' ? '利用開始の案内を開く' : 'リビジョン 1 を表示' }));
    if (contentState === 'ready') await screen.findByRole('link', { name: '商品を開く' });
    else await screen.findByText('提供終了', { exact: true });
    const link = screen.queryByRole('link', { name: '保護ダウンロードを開く' });
    if (enabled && contentState === 'ready') {
      expect(link?.tagName).toBe('A'); expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).not.toHaveAttribute('data-prefetch');
      expect(screen.getByText('リンクは60秒で失効します。失効したらもう一度押してください。')).toBeInTheDocument();
      fireEvent.mouseOver(link!); fireEvent.focus(link!);
    } else {
      expect(link).not.toBeInTheDocument();
      expect(screen.queryByText('リンクは60秒で失効します。失効したらもう一度押してください。')).not.toBeInTheDocument();
    }
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/store/delivery/'))).toBe(false);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('ticket=');
  });
});
