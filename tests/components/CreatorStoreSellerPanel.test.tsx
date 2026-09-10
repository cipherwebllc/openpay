import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';

const ADDRESS = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const state = vi.hoisted(() => ({
  enabled: true,
  licenseEnabled: false,
  deliveryEnabled: false,
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
      get enableStoreDeliveryTicketUi() { return state.enabled && state.deliveryEnabled; },
      get enableLicenseNftUi() { return state.enabled && state.licenseEnabled; },
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
  payTo: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  galleryUrls?: readonly string[];
  priceJpyc: string;
  contentKind: 'url' | 'text';
  label: 'download' | 'pdf' | 'zip' | 'prompt' | 'api' | 'external';
  saleActive: boolean;
  usdcEnabled?: true;
  contentAvailable: boolean;
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderPanel(handle?: string | null, locale: 'ja' | 'en' = 'ja') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithIntl(
    <QueryClientProvider client={queryClient}>
      <CreatorStoreSellerPanel handle={handle} />
    </QueryClientProvider>,
    { locale },
  );
}

beforeEach(() => {
  state.enabled = true;
  state.licenseEnabled = false;
  state.deliveryEnabled = false;
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
        payTo: ADDRESS,
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
        payTo: ADDRESS,
        title: '配布中 PDF',
        priceJpyc: '300',
        contentKind: 'url',
        label: 'pdf',
        saleActive: true,
        contentAvailable: true,
      },
      {
        id: 'h_' + '3'.repeat(32),
        payTo: ADDRESS,
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
    expect(
      screen.getByRole('checkbox', {
        name: 'USDC での購入も許可する',
      }),
    ).toBeChecked();
    expect(
      screen.getByText(
        'この受取アドレスが Base チェーンで USDC を受け取ります。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(
      screen.getByText(/受取後の USDC の価格変動・保有リスクは販売者が負担/),
    ).toBeInTheDocument();
  });

  it.each([
    [
      'payTo must not be the fee receiver',
      /受け取り先にこのウォレットは使えません/,
    ],
    ['invalid imageUrl', /画像 URL は https:\/\//],
    ['invalid deliveryUrl', /保護配布先は https:\/\//],
    ['too many gallery images', /追加画像は最大 4 枚/],
    ['invalid gallery image', /追加画像 URL は 1 行ごとに https:\/\//],
  ])(
    'invalid_product の detail「%s」を具体的な理由メッセージで表示する',
    async (invalidDetail, expectedMessage) => {
      state.deliveryEnabled = invalidDetail === 'invalid deliveryUrl';
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
                    payTo: ADDRESS,
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
      usdcEnabled: true,
    });
    expect(screen.getByText(/商品はまだありません/)).toBeInTheDocument();
    expect(screen.queryByText('新商品')).not.toBeInTheDocument();

    resolvePost?.(
      response(
        {
          ok: true,
          product: {
            id: 'h_' + '4'.repeat(32),
            payTo: ADDRESS,
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

  it('既存商品の USDC 現在値を表示し、停止中商品の明示再公開時だけ変更して PATCH する', async () => {
    const id = 'h_' + '9'.repeat(32);
    const product: Product = {
      id,
      payTo: ADDRESS,
      title: 'USDC 対応前の商品',
      priceJpyc: '250',
      contentKind: 'url',
      label: 'download',
      saleActive: false,
      contentAvailable: true,
    };
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
        if (url === `/api/store/products/${id}` && init?.method === 'PATCH') {
          return response({
            ok: true,
            product: { ...product, saleActive: true, usdcEnabled: true },
          });
        }
        if (url === `/api/store/products/${id}`) {
          return response({
            ok: true,
            product,
            content: { kind: 'url', value: 'https://example.com/download' },
          });
        }
        if (url === '/api/store/products') {
          return response({ ok: true, products: [product], max: 12 });
        }
        return response({ ok: false, error: 'not_found' }, 404);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();
    const card = (await screen.findByText(product.title)).closest('li');
    expect(card).not.toBeNull();
    fireEvent.click(within(card!).getByRole('button', { name: '編集' }));

    await screen.findByRole('heading', { name: '商品を編集' });
    const usdcCheckbox = screen.getByRole('checkbox', {
      name: 'USDC での購入も許可する',
    });
    expect(usdcCheckbox).not.toBeChecked();
    expect(usdcCheckbox).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '保存後すぐ販売を開始する',
      }),
    );
    expect(usdcCheckbox).not.toBeDisabled();
    fireEvent.click(usdcCheckbox);
    expect(usdcCheckbox).toBeChecked();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === `/api/store/products/${id}` &&
            (init as RequestInit | undefined)?.method === 'PATCH',
        ),
      ).toBe(true);
    });
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `/api/store/products/${id}` &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(
      JSON.parse((patchCall?.[1] as RequestInit).body as string),
    ).toMatchObject({
      saleActive: true,
      usdcEnabled: true,
    });
  });

  it('USDC 公開を contract wallet で拒否された場合は人が読める理由を表示する', async () => {
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
            { ok: false, error: 'usdc_pay_to_contract_wallet' },
            409,
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
    fireEvent.change(screen.getByRole('textbox', { name: '提供する URL' }), {
      target: { value: 'https://example.com/download' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '保存後すぐ販売を開始する',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '商品を登録' }));

    expect(
      await screen.findByText(
        /Polygon 上のコントラクトウォレットのため、Base で USDC を受け取れることを確認できません/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/usdc_pay_to_contract_wallet/),
    ).not.toBeInTheDocument();
  });

  it('公開 handle があれば販売中商品をコピーし、Clipboard 拒否時は fallback する', async () => {
    const activeId = 'h_' + '5'.repeat(32);
    const products: Product[] = [
      {
        id: activeId,
        payTo: ADDRESS,
        title: '販売中 PDF',
        priceJpyc: '300',
        contentKind: 'url',
        label: 'pdf',
        saleActive: true,
        contentAvailable: true,
      },
      {
        id: 'h_' + '6'.repeat(32),
        payTo: ADDRESS,
        title: '停止中 PDF',
        priceJpyc: '400',
        contentKind: 'url',
        label: 'pdf',
        saleActive: false,
        contentAvailable: true,
      },
      {
        id: 'h_' + '8'.repeat(32),
        payTo: ADDRESS,
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
        payTo: ADDRESS,
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


describe('利用ライセンスの出品', () => {
  function setup(registration?: 'pending' | 'registered' | 'failed') {
    state.licenseEnabled = true;
    let products: Record<string, unknown>[] = registration ? [licenseProduct(registration)] : [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/store/seller') return response({ ok: true, seller: { name: 'Seller', contact: 'seller@example.com', updatedAt: 1 } });
      if (url === '/api/store/products' && init?.method === 'POST') {
        products = [licenseProduct('pending')];
        return response({ ok: true, product: products[0] });
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        products = products.map((p) => ({ ...p, ...body }));
        return response({ ok: true, product: products[0] });
      }
      if (url.startsWith('/api/store/products/')) return response({ ok: true, product: products[0], content: { kind: 'text', value: '案内' } });
      return response({ ok: true, products, max: 24 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  function licenseProduct(registration: string) {
    return { id: 'h_license', payTo: ADDRESS, title: 'API ライセンス', priceJpyc: '1000', contentKind: 'text', label: 'api', contentAvailable: true, saleActive: false,
      productKind: 'license', license: { supply: 10, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1' }, registration: { status: registration } };
  }
  async function fill(custom = true) {
    fireEvent.click(await screen.findByRole('radio', { name: '利用ライセンス NFT' }));
    fireEvent.change(screen.getByLabelText('ライセンス名'), { target: { value: 'API ライセンス' } });
    fireEvent.change(screen.getByLabelText('販売数（1〜10,000）'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('価格（JPYC・1,000 以上）'), { target: { value: '1000' } });
    if (custom) {
      fireEvent.click(screen.getByRole('radio', { name: '自分の利用条件 URL を指定する' }));
      fireEvent.change(screen.getByLabelText('利用条件 URL（https）'), { target: { value: 'https://example.com/terms' } });
    }
  }
  it('既定の標準条件は URL/version を送らず、切替後の独自条件も送信しない', async () => {
    const fetchMock = setup(); renderPanel(); await fill(false);
    const group = screen.getByRole('group', { name: '利用条件' });
    const standard = within(group).getByRole('radio', { name: 'OpenPay 標準条件 (standard-v1) を使う' });
    expect(standard).toBeChecked();
    expect(screen.getByRole('link', { name: '標準条件を読む' })).toHaveAttribute('href', LICENSE_STANDARD_TERMS.url);
    expect(screen.queryByLabelText('利用条件 URL（https）')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('利用条件のバージョン (例: v1)')).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('radio', { name: '自分の利用条件 URL を指定する' }));
    expect(screen.getByLabelText('利用条件 URL（https）')).toBeRequired();
    expect(screen.getByLabelText('利用条件のバージョン (例: v1)')).toHaveAccessibleDescription('条件を変えるときは新しいバージョン名を付けます');
    fireEvent.change(screen.getByLabelText('利用条件 URL（https）'), { target: { value: 'http://invalid.example' } });
    fireEvent.change(screen.getByLabelText('利用条件のバージョン (例: v1)'), { target: { value: 'custom-v9' } });
    fireEvent.click(standard);
    fireEvent.submit(screen.getByLabelText('ライセンス名').closest('form')!);
    await screen.findByText('登録状態: 登録待ち');
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(request?.[1]?.body)).license).toEqual({ supply: 10, transferable: false, termsPreset: 'standard-v1' });
  });
  it('English form shows the same choices, version label and help', async () => {
    setup(); renderPanel(undefined, 'en');
    fireEvent.click(await screen.findByRole('radio', { name: 'Usage license NFT' }));
    expect(screen.getByRole('radio', { name: 'Use OpenPay standard terms (standard-v1)' })).toBeChecked();
    expect(screen.getByRole('link', { name: 'Read the standard terms' })).toHaveAttribute('href', LICENSE_STANDARD_TERMS.url);
    fireEvent.click(screen.getByRole('radio', { name: 'Specify my own terms URL' }));
    expect(screen.getByLabelText('Terms version (e.g. v1)')).toHaveAccessibleDescription('Give a new version name when you change the terms');
  });
  it('出品アカウントとは別の売上受取先を、既存 payTo 入力として指定できる', async () => {
    const fetchMock = setup(); renderPanel(); await fill();
    const payout = `0x${'ab'.repeat(20)}`;
    fireEvent.change(screen.getByLabelText('売上の受取ウォレット'), { target: { value: payout } });
    fireEvent.submit(screen.getByLabelText('ライセンス名').closest('form')!);
    await screen.findByText('登録状態: 登録待ち');
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(request?.[1]?.body));
    expect(body.payTo).toBe(payout);
    expect(body).not.toHaveProperty('owner');
    expect(body).not.toHaveProperty('sellerRole');
  });
  it('作成は未公開・JPYC 限定で独自条件のバージョン/譲渡不可と任意の案内を送る', async () => {
    const fetchMock = setup(); renderPanel(); await fill();
    expect(screen.getByRole('radio', { name: '不可' })).toBeChecked();
    expect(screen.getByLabelText('利用条件のバージョン (例: v1)')).toHaveValue('1');
    expect(screen.getByLabelText('利用開始の案内（テキスト・任意）')).not.toBeRequired();
    expect(screen.getByText('利用ライセンスは JPYC のみです。USDC は利用できません。')).toBeInTheDocument();
    fireEvent.submit(screen.getByLabelText('ライセンス名').closest('form')!);
    await screen.findByText('登録状態: 登録待ち');
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ productKind: 'license', license: { supply: 10, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1' }, priceJpyc: '1000', contentKind: 'text', content: '', saleActive: false, usdcEnabled: false });
    expect(JSON.parse(String(request?.[1]?.body)).license).not.toHaveProperty('termsPreset');
    expect(screen.getByRole('button', { name: '公開する' })).toBeDisabled();
  });
  it.each([
    ['販売数（1〜10,000）', '0'], ['販売数（1〜10,000）', '10001'], ['販売数（1〜10,000）', '1.5'],
    ['価格（JPYC・1,000 以上）', '999'], ['価格（JPYC・1,000 以上）', '1000.5'],
    ['利用条件 URL（https）', 'http://example.com'], ['利用条件 URL（https）', 'https://user:pass@example.com'], ['利用条件のバージョン (例: v1)', '   '],
    ['売上の受取ウォレット', 'invalid'],
  ])('%s = %s は送信しない', async (label, value) => {
    const fetchMock = setup(); renderPanel(); await fill();
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.submit(screen.getByLabelText('ライセンス名').closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('販売数は 1〜10,000');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it.each(['pending', 'failed'] as const)('%s の登録中は公開できない', async (status) => {
    setup(status); renderPanel();
    expect(await screen.findByRole('button', { name: '公開する' })).toBeDisabled();
    expect(screen.getByText(`登録状態: ${status === 'pending' ? '登録待ち' : '失敗'}`)).toBeInTheDocument();
  });
  it('登録済みだけ明示的に公開し、経済条件を PATCH へ含めない', async () => {
    const fetchMock = setup('registered'); renderPanel();
    const publish = await screen.findByRole('button', { name: '公開する' });
    expect(publish).toBeEnabled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    fireEvent.click(publish);
    await screen.findByRole('button', { name: '販売を停止する' });
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ saleActive: true });
    fireEvent.click(screen.getByRole('button', { name: /編集/ }));
    await waitFor(() => expect(screen.getByLabelText('ライセンス名')).toHaveValue('API ライセンス'));
    for (const label of ['売上の受取ウォレット', '販売数（1〜10,000）', '価格（JPYC・1,000 以上）', '利用条件 URL（https）', '利用条件のバージョン (例: v1)', '利用開始の案内（テキスト・任意）']) expect(screen.getByLabelText(label)).toHaveAttribute('readonly');
    expect(screen.getByRole('radio', { name: '不可' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '自分の利用条件 URL を指定する' })).toBeChecked();
    for (const radio of within(screen.getByRole('group', { name: '利用条件' })).getAllByRole('radio')) expect(radio).toBeDisabled();
    fireEvent.change(screen.getByLabelText('ライセンス名'), { target: { value: '更新した名前' } });
    fireEvent.submit(screen.getByLabelText('ライセンス名').closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(2));
    const body = JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')[1][1]?.body));
    expect(body.title).toBe('更新した名前');
    for (const key of ['license', 'priceJpyc', 'contentKind', 'content', 'productKind', 'payTo']) expect(body).not.toHaveProperty(key);
  });
  it('ライセンス flag OFF はタイプ選択とライセンス商品を表示しない', async () => {
    setup('registered'); state.licenseEnabled = false; renderPanel();
    await screen.findByLabelText('商品名');
    expect(screen.queryByRole('radio', { name: '利用ライセンス NFT' })).not.toBeInTheDocument();
    expect(screen.queryByText('API ライセンス')).not.toBeInTheDocument();
  });
});


describe('protected delivery seller field', () => {
  function setup(kind: 'digital' | 'license', editing: boolean) {
    state.licenseEnabled = true;
    const product = { id: 'h_delivery', payTo: ADDRESS, title: 'Delivery product', priceJpyc: '1000', contentKind: 'text', label: 'download', saleActive: false, contentAvailable: true,
      deliveryUrl: 'https://files.example/gate', ...(kind === 'license' ? { productKind: 'license', license: { supply: 1, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1' }, registration: { status: 'registered' } } : {}) };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/store/seller') return response({ ok: true, seller: { name: 'Seller', contact: 'seller@example.com', updatedAt: 1 } });
      if (init?.method === 'POST' || init?.method === 'PATCH') return response({ ok: true, product });
      if (url === '/api/store/products/h_delivery') return response({ ok: true, product, content: { kind: 'text', value: 'Instructions' } });
      return response({ ok: true, products: editing ? [product] : [], max: 12 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  async function openForm(kind: 'digital' | 'license', editing: boolean) {
    if (editing) {
      fireEvent.click(await screen.findByRole('button', { name: '編集' }));
      await screen.findByRole('heading', { name: '商品を編集' });
    } else if (kind === 'license') {
      fireEvent.click(await screen.findByRole('radio', { name: '利用ライセンス NFT' }));
      fireEvent.change(screen.getByLabelText('ライセンス名'), { target: { value: 'License' } });
      fireEvent.change(screen.getByLabelText('価格（JPYC・1,000 以上）'), { target: { value: '1000' } });
      fireEvent.click(screen.getByRole('radio', { name: '自分の利用条件 URL を指定する' }));
      fireEvent.change(screen.getByLabelText('利用条件 URL（https）'), { target: { value: 'https://example.com/terms' } });
    } else {
      fireEvent.change(await screen.findByLabelText('商品名'), { target: { value: 'Digital' } });
      fireEvent.change(screen.getByLabelText('価格 (JPYC)'), { target: { value: '1000' } });
      fireEvent.change(screen.getByLabelText('提供する URL'), { target: { value: 'https://example.com/instructions' } });
    }
  }
  const cases = (['digital', 'license'] as const).flatMap((kind) => [false, true].flatMap((editing) => [false, true].map((enabled) => ({ kind, editing, enabled }))));
  it.each(cases)('$kind editing=$editing flag=$enabled: field and JSON follow the flag', async ({ kind, editing, enabled }) => {
    state.deliveryEnabled = enabled;
    const fetchMock = setup(kind, editing);
    renderPanel(); await openForm(kind, editing);
    const field = screen.queryByRole('textbox', { name: '保護配布先URL' });
    if (enabled) {
      expect(field).toBeVisible(); expect(field).not.toBeRequired(); expect(field).not.toHaveAttribute('readonly');
      expect(field).toHaveValue(editing ? 'https://files.example/gate' : '');
      expect(screen.getByRole('link', { name: '設定手順はガイドを参照' })).toHaveAttribute('href', '/ja/guide/store#protected-delivery');
      fireEvent.change(field!, { target: { value: 'https://new.example/gate' } });
    } else expect(field).not.toBeInTheDocument();
    fireEvent.submit(screen.getByLabelText(kind === 'license' ? 'ライセンス名' : '商品名').closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === (editing ? 'PATCH' : 'POST'))).toBe(true));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === (editing ? 'PATCH' : 'POST'))?.[1]?.body));
    if (enabled) expect(body.deliveryUrl).toBe('https://new.example/gate');
    else expect(body).not.toHaveProperty('deliveryUrl');
    if (kind === 'license' && editing) for (const key of ['license', 'content', 'contentKind', 'priceJpyc', 'payTo']) expect(body).not.toHaveProperty(key);
  });
  it.each(['digital', 'license'] as const)('%s: clearing a saved destination sends an explicit empty string', async (kind) => {
    state.deliveryEnabled = true;
    const fetchMock = setup(kind, true); renderPanel(); await openForm(kind, true);
    const field = screen.getByRole('textbox', { name: '保護配布先URL' });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toHaveProperty('deliveryUrl', '');
  });
});
