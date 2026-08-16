import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStoreLibrary } from '@/components/CreatorStoreLibrary';

const ADDRESS = '0x1234567890123456789012345678901234567890';
const state = vi.hoisted(() => ({
  sessionAddress: '0x1234567890123456789012345678901234567890' as
    | string
    | null,
  isSignedIn: true,
}));

vi.mock('@/lib/env', () => ({
  env: { enableCreatorStoreUi: true },
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
})) {
  return {
    queryClient,
    ...renderWithIntl(
      <QueryClientProvider client={queryClient}>
        <CreatorStoreLibrary />
      </QueryClientProvider>,
    ),
  };
}

describe('CreatorStoreLibrary', () => {
  beforeEach(() => {
    state.sessionAddress = ADDRESS;
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
