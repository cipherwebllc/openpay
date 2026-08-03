import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

const ADDRESS = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const state = vi.hoisted(() => ({
  enabled: true,
  isSignedIn: true,
  sessionAddress: '0x52d4901142e2B5680027da5EB47C86CB02a3cA81',
}));
const signIn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableCreatorStoreUi() {
        return state.enabled;
      },
    },
  };
});

vi.mock('@/hooks/useStoreCacheScope', () => ({
  // scope hook は wagmi/QueryClient に依存するため component テストでは no-op (専用テストで検証)
  useStoreCacheScope: () => {},
}));

vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: state.isSignedIn,
    sessionAddress: state.isSignedIn ? state.sessionAddress : null,
    signIn,
    isSigningIn: false,
    signInError: null,
    signOut: vi.fn(),
    mismatch: false,
    isLoading: false,
  }),
}));

import { CreatorStoreSellerPanel } from '@/components/CreatorStoreSellerPanel';

type Product = {
  id: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  galleryUrls?: readonly string[];
  priceJpyc: string;
  contentKind: 'url' | 'text';
  label: 'download' | 'pdf' | 'zip' | 'prompt' | 'api' | 'external';
  saleActive: boolean;
  contentAvailable: boolean;
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderPanel(handle?: string | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithIntl(
    <QueryClientProvider client={queryClient}>
      <CreatorStoreSellerPanel handle={handle} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.enabled = true;
  state.isSignedIn = true;
  state.sessionAddress = ADDRESS;
  signIn.mockClear();
  vi.unstubAllGlobals();
});

describe('CreatorStoreSellerPanel', () => {
  it('client flag OFF は何も描画せず API にも到達しない', () => {
    state.enabled = false;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderPanel();

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('未サインインは可視 CTA を表示し、owner API を取得しない', () => {
    state.isSignedIn = false;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();
    fireEvent.click(
      screen.getByRole('button', { name: 'ログインして管理' }),
    );

    expect(signIn).toHaveBeenCalledWith(
      'OpenPay でデジタル商品を管理するために署名します',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('販売者未登録では停止中商品の販売開始を無効化し、販売中商品の停止は可能', async () => {
    const products: Product[] = [
      {
        id: 'h_' + '1'.repeat(32),
        title: 'プロンプト集',
        desc: '毎日の執筆に使えるプロンプト',
        emoji: '✍️',
        priceJpyc: '500',
        contentKind: 'text',
        label: 'prompt',
        saleActive: false,
        contentAvailable: true,
      },
      {
        id: 'h_' + '2'.repeat(32),
        title: '配布中 PDF',
        priceJpyc: '300',
        contentKind: 'url',
        label: 'pdf',
        saleActive: true,
        contentAvailable: true,
      },
      {
        id: 'h_' + '3'.repeat(32),
        title: '提供終了商品',
        priceJpyc: '100',
        contentKind: 'text',
        label: 'prompt',
        saleActive: false,
        contentAvailable: false,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/store/products'
          ? response({ ok: true, products, max: 12 })
          : response({ ok: true, seller: null }),
      ),
    );

    renderPanel();

    expect(await screen.findByText('3 / 12 商品')).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: '氏名・名称' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: '購入者向け連絡先' }),
    ).toBeInTheDocument();

    const inactiveCard = screen.getByText('プロンプト集').closest('li');
    expect(inactiveCard).not.toBeNull();
    expect(
      within(inactiveCard!).getByRole('checkbox', { name: '販売停止中' }),
    ).toBeDisabled();
    expect(
      within(inactiveCard!).getByText(
        '販売を始める前に、上の販売者情報を登録してください。',
      ),
    ).toBeInTheDocument();

    const activeCard = screen.getByText('配布中 PDF').closest('li');
    expect(activeCard).not.toBeNull();
    expect(
      within(activeCard!).getByRole('checkbox', { name: '販売中' }),
    ).not.toBeDisabled();

    const unavailableCard = screen.getByText('提供終了商品').closest('li');
    expect(unavailableCard).not.toBeNull();
    expect(
      within(unavailableCard!).getByRole('checkbox', {
        name: '販売停止中',
      }),
    ).toBeDisabled();
    expect(
      within(unavailableCard!).getByRole('button', { name: '編集' }),
    ).toBeDisabled();

    expect(
      screen.getByRole('textbox', { name: '商品名' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: '提供する URL' }),
    ).toBeInTheDocument();
    // P1 (Store 統合): カテゴリー select (9 種 + 未選択) とタグ入力
    const categorySelect = screen.getByRole('combobox', {
      name: 'カテゴリー (任意)',
    });
    expect(
      within(categorySelect).getAllByRole('option').map((o) => o.textContent),
    ).toEqual([
      '未選択',
      'AI',
      'ドキュメント',
      'ソフトウェア',
      '画像・NFT',
      '動画',
      '音楽',
      'テンプレート',
      '3D・ゲーム素材',
      'その他',
    ]);
    expect(
      screen.getByRole('textbox', {
        name: 'タグ (任意・カンマ区切り・最大 5 個)',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', {
        name: '保存後すぐ販売を開始する',
      }),
    ).toBeDisabled();
  });

  it.each([
    [
      'payTo must not be the fee receiver',
      /受け取り先にこのウォレットは使えません/,
    ],
    ['invalid imageUrl', /画像 URL は https:\/\//],
    ['too many gallery images', /追加画像は最大 4 枚/],
    ['invalid gallery image', /追加画像 URL は 1 行ごとに https:\/\//],
  ])(
    'invalid_product の detail「%s」を具体的な理由メッセージで表示する',
    async (invalidDetail, expectedMessage) => {
      const fetchMock = vi.fn(
        async (url: string, init?: RequestInit): Promise<Response> => {
          if (url === '/api/store/seller') {
            return response({
              ok: true,
              seller: {
                name: '山田',
                contact: 'seller@example.com',
                updatedAt: 1,
              },
            });
          }
          if (url === '/api/store/products' && init?.method === 'POST') {
            return response(
              {
                ok: false,
                error: 'invalid_product',
                detail: invalidDetail,
              },
              400,
            );
          }
          if (url === '/api/store/products') {
            return response({ ok: true, products: [], max: 12 });
          }
          return response({ ok: false, error: 'not_found' }, 404);
        },
      );
      vi.stubGlobal('fetch', fetchMock);

      renderPanel();
      await screen.findByText(/商品はまだありません/);
      fireEvent.change(screen.getByRole('textbox', { name: '商品名' }), {
        target: { value: 'テスト商品' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: '価格 (JPYC)' }), {
        target: { value: '100' },
      });
      fireEvent.change(
        screen.getByRole('textbox', { name: '提供する URL' }),
        {
          target: { value: 'https://example.com/x' },
        },
      );
      fireEvent.click(screen.getByRole('button', { name: '商品を登録' }));

      // 生 code (invalid_product) ではなく、何を直せばよいか分かる文言を出す。
      await screen.findByText(expectedMessage);
      expect(screen.queryByText(/invalid_product/)).not.toBeInTheDocument();
    },
  );

  it('商品作成は POST 完了後も楽観追加せず、一覧 GET の再取得結果を表示する', async () => {
    let created = false;
    let resolvePost: ((value: Response) => void) | undefined;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const fetchMock = vi.fn(
      async (url: string, init?: RequestInit): Promise<Response> => {
        if (url === '/api/store/seller') {
          return response({
            ok: true,
            seller: {
              name: '山田',
              contact: 'seller@example.com',
              updatedAt: 1,
            },
          });
        }
        if (url === '/api/store/products' && init?.method === 'POST') {
          const result = await pendingPost;
          created = true;
          return result;
        }
        if (url === '/api/store/products') {
          return response({
            ok: true,
            products: created
              ? [
                  {
                    id: 'h_' + '4'.repeat(32),
                    title: '新商品',
                    priceJpyc: '200',
                    contentKind: 'url',
                    label: 'download',
                    saleActive: false,
                    contentAvailable: true,
                  },
                ]
              : [],
            max: 12,
          });
        }
        return response({ ok: false, error: 'not_found' }, 404);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();
    await screen.findByText(/商品はまだありません/);
    fireEvent.change(screen.getByRole('textbox', { name: '商品名' }), {
      target: { value: '新商品' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '価格 (JPYC)' }), {
      target: { value: '200' },
    });
    fireEvent.change(
      screen.getByRole('textbox', { name: '画像 URL (任意)' }),
      {
        target: { value: ' https://cdn.example.com/product.png ' },
      },
    );
    fireEvent.change(
      screen.getByRole('textbox', {
        name: '追加画像 URL (任意・最大 4)',
      }),
      {
        target: {
          value:
            ' https://cdn.example.com/angle-a.png \n\nhttps://cdn.example.com/angle-b.png  ',
        },
      },
    );
    fireEvent.change(screen.getByRole('textbox', { name: '提供する URL' }), {
      target: { value: 'https://example.com/download' },
    });
    fireEvent.click(screen.getByRole('button', { name: '商品を登録' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === '/api/store/products' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/store/products' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(
      JSON.parse((postCall?.[1] as RequestInit).body as string),
    ).toMatchObject({
      imageUrl: 'https://cdn.example.com/product.png',
      galleryUrls: [
        'https://cdn.example.com/angle-a.png',
        'https://cdn.example.com/angle-b.png',
      ],
    });
    expect(screen.getByText(/商品はまだありません/)).toBeInTheDocument();
    expect(screen.queryByText('新商品')).not.toBeInTheDocument();

    resolvePost?.(
      response(
        {
          ok: true,
          product: {
            id: 'h_' + '4'.repeat(32),
            title: '新商品',
          },
        },
        201,
      ),
    );

    expect(await screen.findByText('新商品')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === '/api/store/products' &&
          (init as RequestInit | undefined)?.method === undefined,
      ),
    ).toHaveLength(2);
  });

  it('公開 handle があれば販売中商品をコピーし、Clipboard 拒否時は fallback する', async () => {
    const activeId = 'h_' + '5'.repeat(32);
    const products: Product[] = [
      {
        id: activeId,
        title: '販売中 PDF',
        priceJpyc: '300',
        contentKind: 'url',
        label: 'pdf',
        saleActive: true,
        contentAvailable: true,
      },
      {
        id: 'h_' + '6'.repeat(32),
        title: '停止中 PDF',
        priceJpyc: '400',
        contentKind: 'url',
        label: 'pdf',
        saleActive: false,
        contentAvailable: true,
      },
      {
        id: 'h_' + '8'.repeat(32),
        title: '提供終了 PDF',
        priceJpyc: '500',
        contentKind: 'url',
        label: 'pdf',
        saleActive: true,
        contentAvailable: false,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/store/products'
          ? response({ ok: true, products, max: 12 })
          : response({
              ok: true,
              seller: {
                name: '山田',
                contact: 'seller@example.com',
                updatedAt: 1,
              },
            }),
      ),
    );
    const previousClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const previousExecCommand = Object.getOwnPropertyDescriptor(
      document,
      'execCommand',
    );
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    try {
      renderPanel('alice');

      const copyButton = await screen.findByRole('button', {
        name: 'シェア用リンクをコピー',
      });
      expect(
        screen.getAllByRole('button', {
          name: 'シェア用リンクをコピー',
        }),
      ).toHaveLength(1);

      fireEvent.click(copyButton);

      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          `https://test.local/ja/@alice?product=${activeId}`,
        ),
      );
      expect(
        await screen.findByRole('button', { name: 'コピーしました' }),
      ).toBeInTheDocument();

      writeText.mockRejectedValueOnce(new Error('clipboard_denied'));
      fireEvent.click(
        screen.getByRole('button', { name: 'コピーしました' }),
      );
      await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
    } finally {
      if (previousExecCommand) {
        Object.defineProperty(
          document,
          'execCommand',
          previousExecCommand,
        );
      } else {
        // @ts-expect-error テストで追加した legacy browser API を元へ戻す。
        delete document.execCommand;
      }
      if (previousClipboard) {
        Object.defineProperty(navigator, 'clipboard', previousClipboard);
      } else {
        // @ts-expect-error テストで追加した readonly browser API を元へ戻す。
        delete navigator.clipboard;
      }
    }
  });

  it('公開 handle がなければ販売中の商品にもシェア導線を表示しない', async () => {
    const products: Product[] = [
      {
        id: 'h_' + '7'.repeat(32),
        title: '販売中 PDF',
        priceJpyc: '300',
        contentKind: 'url',
        label: 'pdf',
        saleActive: true,
        contentAvailable: true,
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/store/products'
          ? response({ ok: true, products, max: 12 })
          : response({
              ok: true,
              seller: {
                name: '山田',
                contact: 'seller@example.com',
                updatedAt: 1,
              },
            }),
      ),
    );

    renderPanel(null);

    expect(await screen.findByText('販売中 PDF')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'シェア用リンクをコピー' }),
    ).not.toBeInTheDocument();
  });
});
