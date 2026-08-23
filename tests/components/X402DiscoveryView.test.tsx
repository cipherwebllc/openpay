import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

// wagmi / SIWE を最小モック (実 wallet グラフを描画せず OOM を避ける)。
const state = vi.hoisted(() => ({
  connected: false,
  address: undefined as string | undefined,
  signedIn: false,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address, isConnected: state.connected }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: state.signedIn,
    signIn: vi.fn(async () => {}),
    isSigningIn: false,
  }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">ウォレットを接続</button>,
}));
// dual-rail UI flag だけ差し替え可能にする (他の env は実値)。既定 OFF = 従来描画。
const envState = vi.hoisted(() => ({ enableX402DualRailUi: false }));
vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...mod,
    env: new Proxy(mod.env, {
      get: (t, p) =>
        p === 'enableX402DualRailUi'
          ? envState.enableX402DualRailUi
          : (t as Record<string | symbol, unknown>)[p],
    }),
  };
});

import { X402DiscoveryView } from '@/components/X402DiscoveryView';
import { MAX_RESOURCES_PER_MERCHANT } from '@/lib/x402/registry';

const ITEM = {
  resource: 'https://api.example.jp/paid/translate',
  description: 'JP→EN 翻訳 API です',
  category: 'api',
  priceJpyc: '1000',
  accepts: [{ extra: { openpay: { feeValue: (10n * 10n ** 18n).toString() } } }],
};

// owner 一覧 (GET /api/facilitator/resources)。url/description はカタログの ITEM と被らせない
// (両方描画されるので getByText が一意になるように)。
const OWNED = {
  id: 'res-1',
  url: 'https://api.example.jp/paid/owned',
  description: '自分の有料 API',
  priceJpyc: '1000',
  category: 'api',
  payTo: '0x1111111111111111111111111111111111111111',
};
type OwnedFixture = typeof OWNED & {
  docsUrl?: string;
  license?: string;
  hidden?: boolean;
  paywallSnippet?: string;
};

// URL+method でルーティングする fetch モック (編集/削除の呼び出しを検証)。
function installRoutingFetch(owned: OwnedFixture[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u === '/api/discovery') {
      return { ok: true, json: async () => ({ x402Version: 1, items: [ITEM] }) };
    }
    if (u === '/api/facilitator/resources' && method === 'GET') {
      return { ok: true, json: async () => ({ resources: owned }) };
    }
    if (u.startsWith('/api/facilitator/resources/') && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, json: async () => ({ resource: body }) };
    }
    if (u.startsWith('/api/facilitator/resources/') && method === 'DELETE') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (u === '/api/facilitator/resources' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return { ok: true, json: async () => ({ resource: body, paywallSnippet: 'snippet' }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  state.connected = false;
  state.address = undefined;
  state.signedIn = false;
  envState.enableX402DualRailUi = false;
  // onEdit は window.scrollTo を呼ぶ (jsdom 未実装) → no-op で stub。
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ x402Version: 1, items: [ITEM] }),
  })) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// X402DiscoveryView は useQuery/useMutation を使うため QueryClientProvider が要る。
// テスト毎に新しい QueryClient を作りキャッシュを分離する (retry:false で失敗を即時に反映)。
function renderView(): ReturnType<typeof renderWithIntl> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <X402DiscoveryView maxResourcesPerMerchant={MAX_RESOURCES_PER_MERCHANT} />
    </QueryClientProvider>,
  );
}

// owner サインイン状態で描画する共通ヘルパ。
function renderAsOwner(owned: OwnedFixture[] = [OWNED]): ReturnType<typeof vi.fn> {
  state.connected = true;
  state.address = OWNED.payTo;
  state.signedIn = true;
  const fetchFn = installRoutingFetch(owned);
  renderView();
  return fetchFn;
}

describe('X402DiscoveryView', () => {
  it('未接続: connectPrompt を表示し、カタログを /api/discovery から列挙', async () => {
    renderView();
    // カタログ (公開・wallet 不要) が描画される。
    expect(await screen.findByText('JP→EN 翻訳 API です')).toBeInTheDocument();
    expect(screen.getByText(ITEM.resource)).toBeInTheDocument();
    // fee 注記 (手数料 10 JPYC)。
    expect(screen.getByText(/手数料 10 JPYC/)).toBeInTheDocument();
    // 未接続 → 登録には接続を促す。
    expect(screen.getByText('出品するにはウォレットを接続')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ウォレットを接続' })).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/discovery', { cache: 'no-store' });
  });

  it('未接続: 公開カタログを登録フォームより前に表示', async () => {
    renderView();
    const catalogHeading = await screen.findByRole('heading', { name: 'カタログ' });
    const registrationHeading = screen.getByRole('heading', {
      name: 'API を出品する',
    });
    expect(
      catalogHeading.compareDocumentPosition(registrationHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('接続済み: 登録フォームを公開カタログより前に表示', async () => {
    state.connected = true;
    state.address = OWNED.payTo;
    renderView();
    const catalogHeading = await screen.findByRole('heading', { name: 'カタログ' });
    const registrationHeading = screen.getByRole('heading', {
      name: 'API を出品する',
    });
    expect(
      registrationHeading.compareDocumentPosition(catalogHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('カタログ検索: 名前・URL の部分一致を大小文字を無視して絞り込む', async () => {
    const weather = {
      ...ITEM,
      resource: 'https://data.example.jp/paid/Weather-Forecast',
      description: 'Tokyo Weather Data',
      category: 'data',
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [ITEM, weather] }),
    })) as unknown as typeof fetch;
    renderView();

    const search = await screen.findByPlaceholderText('名前・URL で検索');
    fireEvent.change(search, { target: { value: 'WEATHER data' } });
    expect(screen.getByText(weather.description)).toBeInTheDocument();
    expect(screen.queryByText(ITEM.description)).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'EXAMPLE.JP/PAID/WEATHER' } });
    expect(screen.getByText(weather.description)).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByText(ITEM.description)).toBeInTheDocument();
    expect(screen.getByText(weather.description)).toBeInTheDocument();
  });

  it('カテゴリ chip: 実在カテゴリと件数だけを表示し、切替で絞り込む', async () => {
    const dataItem = {
      ...ITEM,
      resource: 'https://data.example.jp/paid/directory',
      description: '店舗データ',
      category: 'data',
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [
          ITEM,
          {
            ...ITEM,
            resource: 'https://api.example.jp/two',
            description: 'Second API',
          },
          dataItem,
        ],
      }),
    })) as unknown as typeof fetch;
    renderView();

    expect(await screen.findByRole('button', { name: 'すべて 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'api 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'data 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mcp/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /content/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'data 1' }));
    expect(screen.getByText(dataItem.description)).toBeInTheDocument();
    expect(screen.queryByText(ITEM.description)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'すべて 3' }));
    expect(screen.getByText(ITEM.description)).toBeInTheDocument();
  });

  it('検索・カテゴリで 0 件になると該当なしの空状態を表示', async () => {
    renderView();
    fireEvent.change(await screen.findByPlaceholderText('名前・URL で検索'), {
      target: { value: '存在しないリソース' },
    });
    expect(screen.getByText('該当するリソースがありません')).toBeInTheDocument();
    expect(screen.queryByText(ITEM.description)).not.toBeInTheDocument();
  });

  it('filter 後も first-party を先頭にした元の並び順を維持する', async () => {
    const firstParty = {
      ...ITEM,
      resource: 'https://open-pay.jp/api/paid/demo',
      description: 'OpenPay demo',
      official: true,
    };
    const merchant = {
      ...ITEM,
      resource: 'https://merchant.example.jp/paid/api',
      description: 'Merchant API',
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [firstParty, merchant, { ...ITEM, category: 'data' }] }),
    })) as unknown as typeof fetch;
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'api 2' }));
    const firstCard = screen.getByText(firstParty.description).closest('li');
    const merchantCard = screen.getByText(merchant.description).closest('li');
    expect(firstCard?.nextElementSibling).toBe(merchantCard);
    expect(within(firstCard!).getByText('公式')).toBeInTheDocument();
  });

  it('公式バッジは server の official:true だけを信頼し、URL 一致だけでは付けない', async () => {
    const serverOfficial = {
      ...ITEM,
      resource: 'https://open-pay.jp/api/paid/demo',
      description: 'OpenPay demo',
      official: true,
    };
    const forged = {
      ...ITEM,
      resource: 'https://open-pay.jp/api/paid/stores',
      description: '第三者が登録した偽の公式 API',
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [serverOfficial, forged] }),
    })) as unknown as typeof fetch;
    renderView();

    const officialCard = (await screen.findByText(serverOfficial.description)).closest('li');
    const forgedCard = screen.getByText(forged.description).closest('li');
    expect(within(officialCard!).getByText('公式')).toBeInTheDocument();
    expect(within(forgedCard!).queryByText('公式')).not.toBeInTheDocument();
  });

  it('リソース URL は https のみ安全な外部リンクにする', async () => {
    const insecure = {
      ...ITEM,
      resource: 'http://api.example.jp/paid/insecure',
      description: 'HTTP resource',
      category: 'data',
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [ITEM, insecure] }),
    })) as unknown as typeof fetch;
    renderView();

    const secureLink = await screen.findByRole('link', { name: ITEM.resource });
    expect(secureLink).toHaveAttribute('href', ITEM.resource);
    expect(secureLink).toHaveAttribute('target', '_blank');
    expect(secureLink).toHaveAttribute('rel', 'noreferrer noopener');
    expect(screen.queryByRole('link', { name: insecure.resource })).not.toBeInTheDocument();
    expect(screen.getByText(insecure.resource)).toBeInTheDocument();
  });

  it('カタログ比較メタ行に相対検証日・更新日・license・安全な Docs リンクを表示', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-14T12:00:00.000Z'));
    const compared = {
      ...ITEM,
      verifiedAt: '2026-07-12T12:00:00.000Z',
      updatedAt: '2026-07-13T01:02:03.000Z',
      license: 'Commercial use with attribution.',
      docsUrl: 'https://docs.example.jp/openapi.json',
    };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [compared] }),
    })) as unknown as typeof fetch;
    renderView();

    expect(await screen.findByText('検証: 2日前')).toHaveAttribute(
      'datetime',
      compared.verifiedAt,
    );
    expect(screen.getByText('更新: 2026-07-13')).toHaveAttribute(
      'datetime',
      compared.updatedAt,
    );
    expect(
      screen.getByText('利用条件: Commercial use with attribution.'),
    ).toBeInTheDocument();
    const docs = screen.getByRole('link', { name: 'Docs' });
    expect(docs).toHaveAttribute('href', compared.docsUrl);
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs).toHaveAttribute('rel', 'noreferrer noopener');
  });

  it('サインイン済: 登録フォーム (URL/価格 入力) を表示', async () => {
    state.connected = true;
    state.address = '0x1111111111111111111111111111111111111111';
    state.signedIn = true;
    renderView();
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/リソース URL/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText('価格 (JPYC・整数)')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('OpenAPI またはドキュメントの HTTPS URL'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例: 商用利用可・要帰属')).toBeInTheDocument();
    expect(
      screen.getByText(/掲載条件: 実在する 402 ゲート/),
    ).toBeInTheDocument();
    expect(screen.getByText('サインイン済: 0x1111…1111')).toHaveAttribute(
      'title',
      state.address,
    );
    const orderedFields = [
      screen.getByText('リソース URL'),
      screen.getByText('説明'),
      screen.getByText('価格'),
      screen.getByText('カテゴリー'),
      screen.getByText('受取アドレス'),
      screen.getByText('任意項目（Docs・利用条件）'),
      screen.getByText('Docs URL（任意）'),
      screen.getByText('利用条件（任意）'),
    ];
    for (let index = 0; index < orderedFields.length - 1; index += 1) {
      expect(
        orderedFields[index].compareDocumentPosition(orderedFields[index + 1]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    const priceAndCategoryRow = orderedFields[2].parentElement?.parentElement;
    expect(priceAndCategoryRow).toBe(orderedFields[3].parentElement?.parentElement);
    expect(priceAndCategoryRow).toHaveClass('grid-cols-2');
    expect(screen.getByRole('button', { name: '登録する' })).toBeInTheDocument();
    expect(screen.getByText(`登録済み 0 / ${MAX_RESOURCES_PER_MERCHANT} 件`)).toBeInTheDocument();
  });

  it('owner: 自分の登録一覧 (あなたの登録) を編集/削除ボタン付きで表示', async () => {
    renderAsOwner();
    expect(await screen.findByText('あなたの登録')).toBeInTheDocument();
    expect(
      screen.getByText(`登録済み 1 / ${MAX_RESOURCES_PER_MERCHANT} 件`),
    ).toBeInTheDocument();
    expect(screen.getByText('自分の有料 API')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'スニペット' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
  });

  it('owner: Docs・利用条件をカード直下へ同じ meta 行で表示し、非 HTTPS Docs は出さない', async () => {
    const ownedWithMeta = {
      ...OWNED,
      docsUrl: 'https://docs.example.jp/owned.json',
      license: 'Attribution required.',
    };
    const ownedWithUnsafeDocs = {
      ...OWNED,
      id: 'res-2',
      url: 'https://api.example.jp/paid/unsafe-docs',
      description: '安全でない Docs の掲載',
      docsUrl: 'http://docs.example.jp/unsafe',
    };
    renderAsOwner([ownedWithMeta, ownedWithUnsafeDocs]);

    const description = await screen.findByText(ownedWithMeta.description);
    const card = description.closest('li')!;
    const docs = within(card).getByRole('link', { name: 'Docs' });
    const license = within(card).getByText('利用条件: Attribution required.');
    const metaRow = docs.parentElement!;
    expect(metaRow.previousElementSibling).toBe(description.parentElement);
    expect(metaRow).toHaveClass('flex-wrap', 'items-baseline', 'text-[11px]');
    expect(
      docs.compareDocumentPosition(license) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(docs).toHaveAttribute('href', ownedWithMeta.docsUrl);
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs).toHaveAttribute('rel', 'noreferrer noopener');

    const unsafeCard = screen.getByText(ownedWithUnsafeDocs.description).closest('li')!;
    expect(within(unsafeCard).queryByRole('link', { name: 'Docs' })).not.toBeInTheDocument();
    expect(unsafeCard.querySelector('.items-baseline')).not.toBeInTheDocument();
  });

  it('owner: hidden の自リソースに要対応バッジとゲートスニペットを再掲', async () => {
    const repairSnippet = 'export async function GET() { return new Response(null, { status: 402 }); }';
    renderAsOwner([{ ...OWNED, hidden: true, paywallSnippet: repairSnippet }]);

    expect(await screen.findByText('要対応')).toBeInTheDocument();
    expect(
      screen.getByText(/公開カタログから一時的に非表示/),
    ).toBeInTheDocument();
    expect(screen.getByText(repairSnippet)).toBeInTheDocument();
  });

  it('登録上限: N/100 を amber 表示し、警告とともに新規登録を事前 disable', async () => {
    const ownedAtLimit = Array.from({ length: MAX_RESOURCES_PER_MERCHANT }, (_, index) => ({
      ...OWNED,
      id: `res-${index}`,
      url: `${OWNED.url}/${index}`,
      description: `${OWNED.description} ${index}`,
    }));
    renderAsOwner(ownedAtLimit);

    const counter = await screen.findByText(
      `登録済み ${MAX_RESOURCES_PER_MERCHANT} / ${MAX_RESOURCES_PER_MERCHANT} 件`,
    );
    expect(counter).toHaveClass('text-amber-700');
    expect(
      screen.getByText(
        '登録上限に達しています。新しく登録するには、不要な登録を削除してください。',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: '登録する' })).toBeDisabled();
  });

  it('編集: 編集ボタンでフォームに値が入り PATCH /resources/:id を呼ぶ', async () => {
    const ownedWithComparison = {
      ...OWNED,
      docsUrl: 'https://docs.example.jp/owned.json',
      license: 'Attribution required.',
    };
    const fetchFn = renderAsOwner([ownedWithComparison]);
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    // フォームが編集モードになり、対象の値が入る。
    await waitFor(() => expect(screen.getByDisplayValue(OWNED.url)).toBeInTheDocument());
    expect(screen.getByText('掲載を編集')).toBeInTheDocument();
    expect(screen.getByDisplayValue(ownedWithComparison.docsUrl)).toBeInTheDocument();
    expect(screen.getByDisplayValue(ownedWithComparison.license)).toBeInTheDocument();
    // 価格を書き換えて更新。
    const price = screen.getByPlaceholderText('価格 (JPYC・整数)');
    fireEvent.change(price, { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: '更新する' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        `/api/facilitator/resources/${OWNED.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    expect(await screen.findByText('更新しました。')).toBeInTheDocument();
  });

  it('編集キャンセル: キャンセルでフォームが登録モードに戻る', async () => {
    renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    await waitFor(() => expect(screen.getByText('掲載を編集')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '登録する' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: '更新する' })).not.toBeInTheDocument();
  });

  it('削除: 確認 → 削除する で DELETE /resources/:id を呼び「削除しました」', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    expect(await screen.findByText('この掲載を削除しますか？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        `/api/facilitator/resources/${OWNED.id}`,
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(await screen.findByText('削除しました。')).toBeInTheDocument();
  });

  it('削除キャンセル: やめる で DELETE を呼ばない', async () => {
    const fetchFn = renderAsOwner();
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    fireEvent.click(await screen.findByRole('button', { name: 'やめる' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument(),
    );
    expect(screen.queryByText('この掲載を削除しますか？')).not.toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining(`/api/facilitator/resources/${OWNED.id}`),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('登録: 表明チェック → POST /resources (attested:true + 入力値) → 「登録しました」+ スニペット', async () => {
    state.connected = true;
    state.address = '0x2222222222222222222222222222222222222222';
    state.signedIn = true;
    const fetchFn = installRoutingFetch([]); // owned 空 = 登録フォームのみ
    renderView();

    fireEvent.change(await screen.findByPlaceholderText(/リソース URL/), {
      target: { value: 'https://api.example.jp/paid/new' },
    });
    fireEvent.change(screen.getByPlaceholderText('説明 (何を提供するか)'), {
      target: { value: '新しい有料 API' },
    });
    fireEvent.change(screen.getByPlaceholderText('価格 (JPYC・整数)'), {
      target: { value: '500' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('OpenAPI またはドキュメントの HTTPS URL'),
      { target: { value: 'https://docs.example.jp/openapi.json' } },
    );
    fireEvent.change(screen.getByPlaceholderText('例: 商用利用可・要帰属'), {
      target: { value: '商用利用可・要帰属' },
    });

    // 境界: 表明前は登録ボタン disabled・案内文を表示。
    const submit = screen.getByRole('button', { name: '登録する' });
    expect(submit).toBeDisabled();
    expect(screen.getByText('登録には上記の表明への同意が必要です。')).toBeInTheDocument();
    // 表明にチェック → 有効化。
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/facilitator/resources',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    // 実出力の検査: 送信 body に attested:true + 入力値が乗る。
    const postCall = fetchFn.mock.calls.find(
      ([u, init]) =>
        u === '/api/facilitator/resources' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    const sentBody = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(sentBody).toMatchObject({
      url: 'https://api.example.jp/paid/new',
      description: '新しい有料 API',
      priceJpyc: '500',
      docsUrl: 'https://docs.example.jp/openapi.json',
      license: '商用利用可・要帰属',
      attested: true,
    });
    // 成功表示 + 402 スニペット。
    expect(await screen.findByText('登録しました。')).toBeInTheDocument();
    expect(screen.getByText('あなたのサーバで 402 を返す例:')).toBeInTheDocument();
  });

  it('正当性表明: 法的文言を details に保持し「詳しく」で展開できる', async () => {
    renderAsOwner([]);
    const legalText =
      '私は、このリソースを提供・課金する正当な権利を有し、支払いで制限 (HTTP 402 等でゲート) していることを表明します。';

    expect(await screen.findByText(legalText)).toBeInTheDocument();
    const detailsLabel = screen.getByText('詳しく');
    const details = detailsLabel.closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(detailsLabel);
    expect(details).toHaveAttribute('open');
    expect(within(details!).getByText(legalText)).toBeInTheDocument();
  });

  it.each([
    ['resource_not_gated', /HTTP 402 応答が返らないため登録できません/],
    ['attestation_required', /正当な権利があり、支払いゲートを実装している/],
    [
      'too_many_resources',
      `登録上限（${MAX_RESOURCES_PER_MERCHANT} 件）に達しています。不要な登録を削除してから追加してください。`,
    ],
  ])('登録エラー %s → 対応文言を表示', async (errCode, expected) => {
    state.connected = true;
    state.address = '0x2222222222222222222222222222222222222222';
    state.signedIn = true;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/api/facilitator/resources' && method === 'POST') {
        return { ok: false, json: async () => ({ error: errCode }) };
      }
      if (u === '/api/facilitator/resources') return { ok: true, json: async () => ({ resources: [] }) };
      return { ok: true, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;
    renderView();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('gate_not_openpay 422 → 専用カードとスニペットを表示し、入力保持のまま再登録できる', async () => {
    state.connected = true;
    state.address = '0x2222222222222222222222222222222222222222';
    state.signedIn = true;
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const paywallSnippet =
      "export async function GET() { return Response.json({ accepts: ['OpenPay'] }, { status: 402 }); }";
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/api/facilitator/resources' && method === 'POST') {
        return {
          ok: false,
          status: 422,
          json: async () => ({ error: 'gate_not_openpay', paywallSnippet }),
        };
      }
      if (u === '/api/facilitator/resources') {
        return { ok: true, json: async () => ({ resources: [] }) };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    });
    global.fetch = fetchFn as unknown as typeof fetch;
    renderView();

    const urlInput = await screen.findByPlaceholderText(/リソース URL/);
    fireEvent.change(urlInput, { target: { value: 'https://api.example.jp/paid/foreign' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));

    expect(
      await screen.findByText(
        'この URL に OpenPay の JPYC ゲート（402 応答）が確認できませんでした。下のスニペットをサイトに設置してから、もう一度登録してください。',
      ),
    ).toBeInTheDocument();
    const snippetCode = screen.getByText(paywallSnippet);
    expect(snippetCode).toBeInTheDocument();
    expect(urlInput).toHaveValue('https://api.example.jp/paid/foreign');
    expect(screen.getByRole('checkbox')).toBeChecked();
    fireEvent.click(within(snippetCode.parentElement!).getByRole('button', { name: 'コピー' }));
    expect(writeText).toHaveBeenCalledWith(paywallSnippet);

    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    await waitFor(() => {
      const posts = fetchFn.mock.calls.filter(
        ([u, init]) =>
          u === '/api/facilitator/resources' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts).toHaveLength(2);
    });
  });

  it('コピー: カタログ URL のコピーボタンで clipboard に書き込み「コピーしました」に変化', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderView();
    await screen.findByText('JP→EN 翻訳 API です');
    fireEvent.click(screen.getByLabelText('コピー'));
    // 実出力: clipboard にカタログ URL が渡る。
    expect(writeText).toHaveBeenCalledWith(ITEM.resource);
    // フィードバック: ラベルが「コピーしました」に変わる。
    expect(await screen.findByLabelText('コピーしました')).toBeInTheDocument();
  });

  it('カタログ: 支払い計 (価格 1000 + 手数料 10 = 1010 JPYC) を表示', async () => {
    renderView();
    expect(await screen.findByText('支払い計 1010 JPYC')).toBeInTheDocument();
  });

  it('2円 demo セクション: curl と buyer script コマンドをコピーできる', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderView();
    fireEvent.click(await screen.findByText('2円で試す (5分)'));
    expect(
      screen.getByText(
        'curl と Node.js があれば、5 分で 402→支払い→解錠の一往復を体験できます。',
      ),
    ).toBeInTheDocument();
    const copyButtons = screen.getAllByRole('button', { name: 'コピー' });
    for (const button of copyButtons) fireEvent.click(button);
    const copied = writeText.mock.calls.map((call) => String(call[0]));
    expect(copied.some((text) => text.includes('BUYER_PRIVATE_KEY=0x...'))).toBe(true);
  });

  it('MCP セクション: 設定 JSON (openpay-x402-mcp) をコピーできる', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderView();
    const title = await screen.findByText('エージェントから払う (MCP)');
    fireEvent.click(title);
    const copyButtons = screen.getAllByRole('button', { name: 'コピー' });
    for (const button of copyButtons) fireEvent.click(button);
    const copied = writeText.mock.calls.map((call) => String(call[0]));
    expect(copied.some((text) => text.includes('openpay-x402-mcp'))).toBe(true);
    // 既定ガードは 3 点の箇条書き。金額・支払先の安全フェンスを固定する。
    const details = title.closest('details')!;
    const guardBullets = within(details)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(guardBullets).toEqual([
      '1 回の上限 10 JPYC',
      '累計上限 100 JPYC',
      '支払い先はカタログ掲載 URL と open-pay.jp のみ',
    ]);
    expect(
      within(details).getByRole('link', {
        name: '詳しくは npm の openpay-x402-mcp',
      }),
    ).toHaveAttribute('href', 'https://www.npmjs.com/package/openpay-x402-mcp');
    const sdkLink = within(details).getByRole('link', { name: 'openpay-x402-sdk' });
    expect(sdkLink).toHaveAttribute(
      'href',
      'https://www.npmjs.com/package/openpay-x402-sdk',
    );
    expect(sdkLink.parentElement).toHaveTextContent(
      'Node.js から直接使う場合は openpay-x402-sdk (npm) — MCP なしで発見→見積り→ガード付き JPYC 支払いができます。',
    );
  });

  it('カタログ: 端数のある手数料を小数で表示 (整数除算で切り捨てない)', async () => {
    // price 250・手数料 2.5 JPYC (atomic 2.5e18)。整数除算だと "2" と誤表示する。
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        x402Version: 1,
        items: [
          {
            resource: 'https://api.example.jp/paid/frac',
            description: '端数手数料 API',
            category: 'api',
            priceJpyc: '250',
            accepts: [{ extra: { openpay: { feeValue: (2500000000000000000n).toString() } } }],
          },
        ],
      }),
    })) as unknown as typeof fetch;
    renderView();
    expect(await screen.findByText(/手数料 2\.5 JPYC/)).toBeInTheDocument();
    expect(screen.getByText('支払い計 252.5 JPYC')).toBeInTheDocument();
  });

  it('空カタログ: catalogEmpty を表示', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ x402Version: 1, items: [] }),
    })) as unknown as typeof fetch;
    renderView();
    expect(
      await screen.findByText('まだ登録されたリソースはありません。'),
    ).toBeInTheDocument();
  });
});

describe('X402DiscoveryView dual-rail USDC 面 (flag ゲート)', () => {
  const USDC_OWNED = {
    ...OWNED,
    usdc: {
      payTo: '0x3333333333333333333333333333333333333333',
      priceUsd: '0.005',
      serviceName: 'My API',
    },
  };

  it('flag OFF (既定): opt-in は出ない (従来フォームのまま)', async () => {
    renderAsOwner([]);
    expect(await screen.findByRole('button', { name: '登録する' })).toBeInTheDocument();
    expect(
      screen.queryByText('USDC (Base) でも販売する — x402 Bazaar に掲載'),
    ).not.toBeInTheDocument();
  });

  it('flag ON: opt-in → 価格入力 → POST body に usdc が乗る', async () => {
    envState.enableX402DualRailUi = true;
    state.connected = true;
    state.address = '0x2222222222222222222222222222222222222222';
    state.signedIn = true;
    const fetchFn = installRoutingFetch([]);
    renderView();

    fireEvent.change(await screen.findByPlaceholderText(/リソース URL/), {
      target: { value: 'https://api.example.jp/paid/new' },
    });
    // flag ON では発見面の注記も dual-rail 版 (「対象外」の否定文と矛盾させない)。
    expect(screen.getByText(/「USDC \(Base\) でも販売する」を有効にすると/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('説明 (何を提供するか)'), {
      target: { value: '新しい有料 API' },
    });
    fireEvent.change(screen.getByPlaceholderText('価格 (JPYC・整数)'), {
      target: { value: '500' },
    });
    // opt-in を有効化 → USDC 入力欄が現れる。
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'USDC (Base) でも販売する — x402 Bazaar に掲載' }),
    );
    fireEvent.change(screen.getByPlaceholderText('0.005'), {
      target: { value: '0.01' },
    });
    fireEvent.change(screen.getByPlaceholderText('例: Weather Forecast API'), {
      target: { value: 'New API' },
    });
    // 正当性表明 (既存 checkbox) → 送信。
    fireEvent.click(screen.getByRole('checkbox', { name: /正当な権利/ }));
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        '/api/facilitator/resources',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const postCall = fetchFn.mock.calls.find(
      ([u, init]) =>
        u === '/api/facilitator/resources' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    const sentBody = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(sentBody.usdc).toEqual({ priceUsd: '0.01', serviceName: 'New API' });
  });

  it('flag OFF でも既存の USDC 面は編集 (PATCH) で黙って消えない (prefill 維持)', async () => {
    const fetchFn = renderAsOwner([USDC_OWNED]);
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    // flag OFF でも prefill された面は見える (見えない状態で消させない)。
    expect(
      screen.getByRole('checkbox', { name: 'USDC (Base) でも販売する — x402 Bazaar に掲載' }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '更新する' }));
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        `/api/facilitator/resources/${USDC_OWNED.id}`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const patchCall = fetchFn.mock.calls.find(
      ([u, init]) =>
        String(u).startsWith('/api/facilitator/resources/') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    const sentBody = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(sentBody.usdc).toEqual({
      priceUsd: '0.005',
      payTo: '0x3333333333333333333333333333333333333333',
      serviceName: 'My API',
    });
  });

  it('owned カードに USDC 面の価格を併記する', async () => {
    renderAsOwner([USDC_OWNED]);
    expect(await screen.findByText('+ 0.005 USDC')).toBeInTheDocument();
  });
});
