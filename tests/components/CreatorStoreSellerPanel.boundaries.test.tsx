import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';
import { CreatorStoreSellerPanel } from '@/components/CreatorStoreSellerPanel';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const state = vi.hoisted(() => ({
  wallet: '', session: null as string | null, license: false, delivery: false,
}));

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true, address: state.wallet }) }));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: state.session !== null, sessionAddress: state.session,
    signIn: vi.fn(), isSigningIn: false, signInError: null,
  }),
}));
vi.mock('@/components/ConnectButton', () => ({ ConnectButton: () => <button>Connect</button> }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: {
    ...actual.env, enableCreatorStoreUi: true,
    get enableLicenseNftUi() { return state.license; },
    get enableStoreDeliveryTicketUi() { return state.delivery; },
  } };
});
// Deliberately use the real useStoreCacheScope with a real QueryClient.

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function product(owner = A) {
  return {
    id: owner === A ? 'h_a' : 'h_b', payTo: owner, title: owner === A ? 'Product A' : 'Product B',
    priceJpyc: '1000', contentKind: 'text', label: 'prompt', saleActive: true,
    contentAvailable: true, usdcEnabled: true,
  };
}

function seller(owner = A) {
  return { name: owner === A ? 'Seller A' : 'Seller B', contact: `${owner}@example.com`, updatedAt: 1 };
}

function ownerResponse(url: string) {
  const owner = state.session ?? A;
  if (url === '/api/store/seller') return response({ ok: true, seller: seller(owner) });
  if (url === '/api/store/products') return response({ ok: true, products: [product(owner)], max: 12 });
  if (url === `/api/store/products/${product(owner).id}`) {
    return response({ ok: true, product: product(owner), content: { kind: 'text', value: `Secret ${owner}` } });
  }
  throw new Error(`Unexpected request: ${url}`);
}

function setup(locale: 'ja' | 'en' = 'ja') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => <QueryClientProvider client={client}><CreatorStoreSellerPanel handle="alice" /></QueryClientProvider>;
  const rendered = renderWithIntl(tree(), { locale });
  return { ...rendered, client, refresh: () => rendered.rerender(tree()) };
}

function content() {
  return document.getElementById('creator-store-product-content')!;
}

function edit(title: string) {
  fireEvent.click(within(screen.getByText(title).closest('li')!).getByRole('button', { name: /編集|Edit/ }));
}

beforeEach(() => {
  state.wallet = A;
  state.session = A;
  state.license = false;
  state.delivery = false;
  vi.unstubAllGlobals();
});

describe('seller private content and session boundaries (rule 15)', () => {
  it.each(['direct', 'sign-out', 'wallet-first'] as const)('late detail cannot replace the new owner editor (%s)', async (transition) => {
    const late = deferred();
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/store/products/h_a' ? late.promise : Promise.resolve(ownerResponse(url))));
    const { client, refresh } = setup();
    await screen.findByText('Product A');
    const privateKey = ['store', A, 'content', 'h_a'];
    client.setQueryData(privateKey, { value: 'Cached secret A' });
    client.setQueryData(['public-catalog'], { value: 'Public' });
    edit('Product A');
    if (transition === 'wallet-first') {
      state.wallet = B;
      refresh();
      expect(client.getQueryData(privateKey)).toBeUndefined();
    }
    if (transition === 'sign-out') {
      state.session = null;
      refresh();
      expect(document.getElementById('creator-store-product-content')).toBeNull();
      expect(client.getQueryData(privateKey)).toBeUndefined();
    }
    state.wallet = B;
    state.session = B;
    refresh();
    await screen.findByText('Product B');
    expect(content()).toHaveValue('');
    edit('Product B');
    await waitFor(() => expect(content()).toHaveValue(`Secret ${B}`));
    fireEvent.change(content(), { target: { value: 'Unsaved B' } });
    await act(async () => { late.resolve(response({ ok: true, product: product(A), content: { kind: 'text', value: 'Late secret A' } })); });
    expect(content()).toHaveValue('Unsaved B');
    expect(screen.getByLabelText('商品名')).toHaveValue('Product B');
    expect(screen.queryByText('Product A')).not.toBeInTheDocument();
    expect(client.getQueryData(privateKey)).toBeUndefined();
    expect(client.getQueryData(['public-catalog'])).toEqual({ value: 'Public' });
    await waitFor(() => expect(client.getMutationCache().getAll().filter((mutation) => mutation.state.variables === 'h_a')).toHaveLength(0));
  });

  it('late initial owner queries cannot repopulate the old scope after switching accounts', async () => {
    const list = deferred();
    const disclosure = deferred();
    vi.stubGlobal('fetch', vi.fn((url: string) => state.session === A
      ? (url === '/api/store/seller' ? disclosure.promise : list.promise)
      : Promise.resolve(ownerResponse(url))));
    const { client, refresh } = setup();
    state.wallet = B;
    state.session = B;
    refresh();
    await screen.findByText('Product B');
    await act(async () => {
      list.resolve(response({ ok: true, products: [product(A)], max: 12 }));
      disclosure.resolve(response({ ok: true, seller: seller(A) }));
    });
    expect(screen.queryByText('Product A')).not.toBeInTheDocument();
    expect(screen.queryByText('Seller A')).not.toBeInTheDocument();
    expect(screen.getByLabelText('氏名・名称')).toHaveValue('Seller B');
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['creator-store'] }).map((query) => query.queryKey))
      .toEqual([['creator-store', 'products', B], ['creator-store', 'seller', B]]));
  });

  it('loaded private drafts disappear on sign-out and do not return on reauthentication', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ownerResponse(url)));
    const { refresh } = setup();
    await screen.findByText('Product A');
    edit('Product A');
    await waitFor(() => expect(content()).toHaveValue(`Secret ${A}`));
    fireEvent.change(content(), { target: { value: 'Unsaved private draft' } });
    fireEvent.change(screen.getByLabelText('氏名・名称'), { target: { value: 'Unsaved seller' } });
    state.session = null;
    refresh();
    expect(document.getElementById('creator-store-product-content')).toBeNull();
    state.session = A;
    refresh();
    await screen.findByText('Product A');
    expect(content()).toHaveValue('');
    expect(screen.getByLabelText('氏名・名称')).toHaveValue('Seller A');
  });

  it.each((['product', 'seller'] as const).flatMap((target) => ['save', 'refetch'].map((phase) => ({ target, phase }))))('late $target $phase cannot reset the new owner drafts', async ({ target, phase }) => {
    const late = deferred();
    const refreshResponse = deferred();
    let saved = false;
    const endpoint = target === 'product' ? '/api/store/products' : '/api/store/seller';
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method) { saved = true; return late.promise; }
      if (saved && state.session === A && url === endpoint) return refreshResponse.promise;
      return Promise.resolve(ownerResponse(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { refresh } = setup();
    await screen.findByText('Product A');
    const field = target === 'product' ? screen.getByLabelText('商品名') : screen.getByLabelText('氏名・名称');
    fireEvent.change(field, { target: { value: 'Draft A' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(saved).toBe(true));
    if (phase === 'refetch') {
      await act(async () => { late.resolve(response({ ok: true, product: product(A), seller: seller(A) })); });
      await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url === endpoint && !init?.method)).toHaveLength(2));
    }
    state.wallet = B;
    state.session = B;
    refresh();
    await screen.findByText('Product B');
    fireEvent.change(screen.getByLabelText('商品名'), { target: { value: 'Draft B' } });
    fireEvent.change(screen.getByLabelText('氏名・名称'), { target: { value: 'Seller draft B' } });
    await act(async () => {
      late.resolve(response({ ok: true, product: product(A), seller: seller(A) }));
      refreshResponse.resolve(response({ ok: true, products: [product(A)], max: 12, seller: seller(A) }));
    });
    expect(screen.getByLabelText('商品名')).toHaveValue('Draft B');
    expect(screen.getByLabelText('氏名・名称')).toHaveValue('Seller draft B');
    expect(screen.queryByText('商品を保存しました。')).not.toBeInTheDocument();
    expect(screen.queryByText('販売者情報を保存しました。')).not.toBeInTheDocument();
  });

  it.each(['product', 'seller'] as const)('%s resets only after a successful refetch and preserves drafts after a failed refetch', async (target) => {
    const refreshed = deferred();
    let didSave = false;
    let retry = false;
    const endpoint = target === 'product' ? '/api/store/products' : '/api/store/seller';
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (init?.method) { didSave = true; return Promise.resolve(response({ ok: true })); }
      if (url === endpoint && didSave && !retry) return refreshed.promise;
      return Promise.resolve(ownerResponse(url));
    }));
    setup();
    await screen.findByText('Product A');
    const label = target === 'product' ? '商品名' : '氏名・名称';
    const field = screen.getByLabelText(label);
    fireEvent.change(field, { target: { value: 'Keep draft' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(didSave).toBe(true));
    expect(field).toHaveValue('Keep draft');
    expect(field.closest('form')!.querySelector('button[type="submit"]')).toBeDisabled();
    await act(async () => { refreshed.resolve(response({ ok: false, error: 'storage_unavailable' }, 503)); });
    const retryButton = await screen.findByRole('button', { name: '再試行' });
    retry = true;
    fireEvent.click(retryButton);
    expect(await screen.findByLabelText(label)).toHaveValue('Keep draft');
    // A second save gets a successful server refetch, so now the local draft resets.
    fireEvent.submit(screen.getByLabelText(label).closest('form')!);
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue(target === 'product' ? '' : 'Seller A'));
  });
});

describe('seller extraction DOM and request pins', () => {
  // SHA-256 of unnormalized container.innerHTML, captured from base 3b205825 before extraction.
  // These fix element/attribute/class/text/order bytes; do not regenerate for a code move.
  const domHashes: Record<string, string> = {
    'ja/empty': '518556dd6f76284d6cfb33dec05ee94ffa7903e7dbcddc0cc4c9aa173e537dfa',
    'ja/list': 'fb383994cbca1c475e971eb33ff0de1f345b182b2bed5ed981dcbcaf151d7994',
    'ja/digital-edit': 'c4f4f7fd00b134625ee3652f9af6e840bc59604890ef576921bd85071c58db87',
    'ja/license-new': '1e35c55eaf402c6f490df754056fc7dfc076051870c3d2fd86ddfd30c324a834',
    'ja/license-edit': '6091cd3ec6e1d526ffaaa785ee302b649d4e894855d06b3a22e71867fea1f92d',
    'en/empty': '8c22ff04b49b246eac4869f4dfddfa12840c8fd0cc1e7f8c02942dd49e45d7ad',
    'en/list': '93591a110c7074edb16d524b1ed04ed590c65ba5cffd03683e1e38e6d8c3af59',
    'en/digital-edit': '1a2a6d5af6f94d15d35a5300ddf52b3ab63ac25a43ffa72aa8c06188c5bd38c6',
    'en/license-new': '6d41c2c5c12b8f566a014d6eb22ec9ff41d611a9b24e90ed483e4121e6e0884c',
    'en/license-edit': '56ac06c56a61621d6088f3340c1ae780347992b43b19f9f14612d5539f9ddcab',
  };
  it.each((['ja', 'en'] as const).flatMap((locale) => ['empty', 'list', 'digital-edit', 'license-new', 'license-edit'].map((mode) => ({ locale, mode }))))('$locale $mode DOM bytes', async ({ locale, mode }) => {
    state.license = mode !== 'empty';
    state.delivery = mode !== 'empty';
    const license = { ...product(), id: 'h_license', title: 'License', productKind: 'license', contentKind: 'text', label: 'api', saleActive: false,
      license: { supply: 10, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1' }, registration: { status: 'pending' } };
    const products = mode === 'empty' ? [] : [product(), { ...product(B), contentAvailable: false, saleActive: false }, license];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/store/seller') return response({ ok: true, seller: mode === 'empty' ? null : seller() });
      if (url === '/api/store/products') return response({ ok: true, products, max: 3 });
      return response({ ok: true, product: url.endsWith('h_license') ? license : product(), content: { kind: 'text', value: 'Private instructions' } });
    }));
    const { container } = setup(locale);
    await waitFor(() => expect(content()).not.toBeNull());
    if (mode.endsWith('-edit')) {
      edit(mode === 'license-edit' ? 'License' : 'Product A');
      await waitFor(() => expect(content()).toHaveValue('Private instructions'));
    }
    if (mode === 'license-new') fireEvent.click(screen.getByRole('radio', { name: locale === 'ja' ? '利用ライセンス NFT' : 'Usage license NFT' }));
    expect(createHash('sha256').update(container.innerHTML).digest('hex')).toBe(domHashes[`${locale}/${mode}`]);
  });

  it.each([false, true])('digital POST preserves raw JSON order, nulls and delivery omission (delivery=%s)', async (delivery) => {
    state.delivery = delivery;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => init?.method ? response({ ok: true }) : ownerResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    setup();
    fireEvent.change(await screen.findByLabelText('商品名'), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText('価格 (JPYC)'), { target: { value: '500' } });
    fireEvent.change(content(), { target: { value: 'https://example.com/private' } });
    fireEvent.submit(screen.getByLabelText('商品名').closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')).toEqual(['/api/store/products', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{"title":"New","desc":null,"details":null,"specs":null,"demoUrl":null,"emoji":null,"imageUrl":null,'
        + (delivery ? '"deliveryUrl":"",' : '')
        + '"galleryUrls":[],"priceJpyc":"500","contentKind":"url","content":"https://example.com/private","label":"download","category":null,"tags":[],"handle":"alice","featured":false,"saleActive":false,"usdcEnabled":true}',
    }]);
  });

  it('seller PUT preserves whitespace and sends null for blank disclosure', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => init?.method ? response({ ok: true }) : ownerResponse(url));
    vi.stubGlobal('fetch', fetchMock);
    setup();
    fireEvent.change(await screen.findByLabelText('氏名・名称'), { target: { value: ' Seller ' } });
    fireEvent.change(screen.getByLabelText('購入者向け連絡先'), { target: { value: ' seller@example.com ' } });
    fireEvent.submit(screen.getByLabelText('氏名・名称').closest('form')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')).toEqual(['/api/store/seller', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: '{"name":" Seller ","contact":" seller@example.com ","disclosure":null}',
    }]);
  });
});

describe('seller request pins for update, license and sale toggles', () => {
  // omitted と null / "" の区別・キー順を生の JSON 文字列で固定する (JSON.parse 比較では順序と省略を見落とす)。
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const rich = {
    id: 'h_rich', payTo: A, title: 'Rich', desc: 'Short', emoji: '🎁', imageUrl: 'https://img.example/a.png',
    deliveryUrl: 'https://files.example/gate', galleryUrls: ['https://img.example/b.png', 'https://img.example/c.png'],
    details: 'Long details', specs: [{ label: 'Format', value: 'PDF' }, { label: 'Pages', value: '12' }],
    demoUrl: 'https://demo.example/try', priceJpyc: '1200', contentKind: 'url', label: 'pdf', category: 'documents',
    tags: ['guide', 'pdf'], handle: 'bob', featured: true, saleActive: true, usdcEnabled: true, contentAvailable: true,
  };
  const license = {
    id: 'h_license', payTo: A, title: 'License', priceJpyc: '1000', contentKind: 'text', label: 'api', saleActive: false,
    contentAvailable: true, productKind: 'license', registration: { status: 'registered' },
    license: { supply: 10, transferable: false, termsUrl: 'https://example.com/terms', termsVersion: '1' },
  };

  function stub(products: unknown[]) {
    const details: Record<string, unknown> = {
      '/api/store/products/h_rich': { product: rich, content: { kind: 'url', value: 'https://private.example/file' } },
      '/api/store/products/h_license': { product: license, content: { kind: 'text', value: 'Private instructions' } },
      '/api/store/products/h_a': { product: product(), content: { kind: 'text', value: `Secret ${A}` } },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return response({ ok: true, product: {} });
      if (url === '/api/store/seller') return response({ ok: true, seller: seller() });
      if (url === '/api/store/products') return response({ ok: true, products, max: 12 });
      return response({ ok: true, ...(details[url] as object) });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function writes(fetchMock: ReturnType<typeof stub>) {
    return fetchMock.mock.calls.filter(([, init]) => init?.method);
  }

  async function submitEditor(fetchMock: ReturnType<typeof stub>, count = 1) {
    fireEvent.submit(content().closest('form')!);
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(count));
  }

  it('owner reads are no-store GETs with no body', async () => {
    const fetchMock = stub([product()]);
    setup();
    await screen.findByText('Product A');
    edit('Product A');
    await waitFor(() => expect(content()).toHaveValue(`Secret ${A}`));
    expect(fetchMock.mock.calls).toEqual([
      ['/api/store/products', { cache: 'no-store' }],
      ['/api/store/seller', { cache: 'no-store' }],
      ['/api/store/products/h_a', { cache: 'no-store' }],
    ]);
  });

  it.each([false, true])('digital PATCH round-trips loaded values in order (delivery=%s)', async (delivery) => {
    state.delivery = delivery;
    const fetchMock = stub([rich]);
    setup();
    await screen.findByText('Rich');
    edit('Rich');
    await waitFor(() => expect(content()).toHaveValue('https://private.example/file'));
    await submitEditor(fetchMock);
    expect(writes(fetchMock)).toEqual([['/api/store/products/h_rich', {
      method: 'PATCH', headers: JSON_HEADERS,
      body: '{"title":"Rich","desc":"Short","details":"Long details","specs":[{"label":"Format","value":"PDF"},{"label":"Pages","value":"12"}],'
        + '"demoUrl":"https://demo.example/try","emoji":"🎁","imageUrl":"https://img.example/a.png",'
        + (delivery ? '"deliveryUrl":"https://files.example/gate",' : '')
        + '"galleryUrls":["https://img.example/b.png","https://img.example/c.png"],"priceJpyc":"1200","contentKind":"url",'
        + '"content":"https://private.example/file","label":"pdf","category":"documents","tags":["guide","pdf"],"handle":"bob",'
        + '"featured":true,"saleActive":true,"usdcEnabled":true}',
    }]]);
  });

  it.each([false, true])('digital PATCH clears optional fields to null/[] and deliveryUrl to "" (delivery=%s)', async (delivery) => {
    state.delivery = delivery;
    const fetchMock = stub([rich]);
    setup();
    await screen.findByText('Rich');
    edit('Rich');
    await waitFor(() => expect(content()).toHaveValue('https://private.example/file'));
    const clear: Record<string, string> = {
      '説明 (任意)': '   ', 詳しい説明: '', 仕様: ' ', '実際に試せる URL': '', '絵文字 (任意)': ' ', '画像 URL (任意)': '',
      '追加画像 URL (任意・最大 4)': '\n', 'カテゴリー (任意)': '', 'タグ (任意・カンマ区切り・最大 5 個)': ' , ',
      掲載するプロフィール: '',
    };
    for (const [label, value] of Object.entries(clear)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    if (delivery) fireEvent.change(screen.getByLabelText('保護配布先URL'), { target: { value: '' } });
    await submitEditor(fetchMock);
    expect(writes(fetchMock)).toEqual([['/api/store/products/h_rich', {
      method: 'PATCH', headers: JSON_HEADERS,
      body: '{"title":"Rich","desc":null,"details":null,"specs":null,"demoUrl":null,"emoji":null,"imageUrl":null,'
        + (delivery ? '"deliveryUrl":"",' : '')
        + '"galleryUrls":[],"priceJpyc":"1200","contentKind":"url","content":"https://private.example/file","label":"pdf",'
        + '"category":null,"tags":[],"handle":null,"featured":true,"saleActive":true,"usdcEnabled":true}',
    }]]);
  });

  it.each([
    { terms: 'standard', delivery: false },
    { terms: 'custom', delivery: true },
  ] as const)('license POST sends creation-only fields ($terms terms, delivery=$delivery)', async ({ terms, delivery }) => {
    state.license = true;
    state.delivery = delivery;
    const fetchMock = stub([]);
    setup();
    fireEvent.click(await screen.findByRole('radio', { name: '利用ライセンス NFT' }));
    fireEvent.change(screen.getByLabelText('ライセンス名'), { target: { value: 'API License' } });
    fireEvent.change(screen.getByLabelText('販売数（1〜10,000）'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('価格（JPYC・1,000 以上）'), { target: { value: '1000' } });
    if (terms === 'custom') {
      fireEvent.click(screen.getByRole('radio', { name: '自分の利用条件 URL を指定する' }));
      fireEvent.change(screen.getByLabelText('利用条件 URL（https）'), { target: { value: 'https://example.com/terms' } });
    }
    await submitEditor(fetchMock);
    expect(writes(fetchMock)).toEqual([['/api/store/products', {
      method: 'POST', headers: JSON_HEADERS,
      body: '{"title":"API License","desc":null,"details":null,"specs":null,"demoUrl":null,"emoji":null,"imageUrl":null,'
        + (delivery ? '"deliveryUrl":"",' : '')
        + '"galleryUrls":[],"priceJpyc":"1000","contentKind":"text","content":"","productKind":"license",'
        + `"payTo":"${A}","license":`
        + (terms === 'standard'
          ? '{"supply":10,"transferable":false,"termsPreset":"standard-v1"}'
          : '{"supply":10,"transferable":false,"termsUrl":"https://example.com/terms","termsVersion":"1"}')
        + ',"label":"api","category":null,"tags":[],"handle":"alice","featured":false,"saleActive":false,"usdcEnabled":false}',
    }]]);
  });

  it.each([false, true])('license PATCH omits immutable fields and saleActive (delivery=%s)', async (delivery) => {
    state.license = true;
    state.delivery = delivery;
    const fetchMock = stub([license]);
    setup();
    await screen.findByText('License');
    edit('License');
    await waitFor(() => expect(content()).toHaveValue('Private instructions'));
    await submitEditor(fetchMock);
    expect(writes(fetchMock)).toEqual([['/api/store/products/h_license', {
      method: 'PATCH', headers: JSON_HEADERS,
      body: '{"title":"License","desc":null,"details":null,"specs":null,"demoUrl":null,"emoji":null,"imageUrl":null,'
        + (delivery ? '"deliveryUrl":"",' : '')
        + '"galleryUrls":[],"label":"api","category":null,"tags":[],"handle":null,"featured":false,"usdcEnabled":false}',
    }]]);
  });

  it('sale toggles PATCH only saleActive for digital and license rows', async () => {
    state.license = true;
    const fetchMock = stub([product(), license]);
    setup();
    await screen.findByText('Product A');
    fireEvent.click(within(screen.getByText('Product A').closest('li')!).getByRole('checkbox'));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    fireEvent.click(within(screen.getByText('License').closest('li')!).getByRole('button', { name: '公開する' }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(2));
    expect(writes(fetchMock)).toEqual([
      ['/api/store/products/h_a', { method: 'PATCH', headers: JSON_HEADERS, body: '{"saleActive":false}' }],
      ['/api/store/products/h_license', { method: 'PATCH', headers: JSON_HEADERS, body: '{"saleActive":true}' }],
    ]);
  });
});

describe('seller extraction DOM pins for error states', () => {
  // SHA-256 of unnormalized container.innerHTML, captured on origin/main (pre-extraction) code.
  // Do not regenerate for a code move; a mismatch means a DOM/wording change.
  const domHashes: Record<string, string> = {
    'ja/errors': '12b094e73a1132acf385e3ccb4a180020e33bdbe989e945601f0442bc1432c20',
    'ja/license-invalid': 'c936032df233130446a9cf0a0f5ecd1792a539da09f627576507cc26d69e01bf',
    'en/errors': '24d3bd6eb05fa4c28c74528c9d0a23fe3489f96000c2e620db3af982e966b414',
    'en/license-invalid': '30cffd291d8e8f6e1267e226a14f77046811e7944dc1dcbb916ebfc54e1fcb29',
  };
  it.each((['ja', 'en'] as const).flatMap((locale) => ['errors', 'license-invalid'].map((mode) => ({ locale, mode }))))('$locale $mode DOM bytes', async ({ locale, mode }) => {
    state.license = true;
    state.delivery = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return response({ ok: false, error: 'invalid_seller', detail: 'invalid name' }, 400);
      if (init?.method === 'PATCH') return response({ ok: false, error: 'usdc_pay_to_contract_wallet' }, 409);
      if (url === '/api/store/seller') return response({ ok: true, seller: seller() });
      if (url === '/api/store/products') return response({ ok: true, products: [product()], max: 12 });
      return response({ ok: true, product: product(), content: null });
    }));
    const { container } = setup(locale);
    await screen.findByText('Product A');
    if (mode === 'errors') {
      fireEvent.submit(document.getElementById('creator-store-seller-name')!.closest('form')!);
      fireEvent.click(within(screen.getByText('Product A').closest('li')!).getByRole('checkbox'));
      edit('Product A');
      // 販売者保存・販売切替・本文読込の 3 つのエラー表示が出揃うまで待つ (各 mutation の settle 後にだけ出る)。
      await waitFor(() => expect(container.querySelectorAll('p.text-red-600')).toHaveLength(3));
    } else {
      fireEvent.click(screen.getByRole('radio', { name: locale === 'ja' ? '利用ライセンス NFT' : 'Usage license NFT' }));
      fireEvent.submit(content().closest('form')!);
      await screen.findByRole('alert');
    }
    expect(createHash('sha256').update(container.innerHTML).digest('hex')).toBe(domHashes[`${locale}/${mode}`]);
  });
});

// R11a で唯一 verbatim でない継ぎ目 (editor の inline onSubmit → 親から渡す prop)。jsdom の submit は
// 遷移しないため、preventDefault が抜けても他の test では見えない (実ブラウザでは /create が再読込され下書きが消える)。
describe('seller form submit seam', () => {
  it.each(['seller', 'product', 'license-invalid'] as const)('%s submit is default-prevented', async (target) => {
    state.license = target === 'license-invalid';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method ? response({ ok: true }) : ownerResponse(url)));
    setup();
    await screen.findByText('Product A');
    if (target === 'license-invalid') fireEvent.click(screen.getByRole('radio', { name: '利用ライセンス NFT' }));
    const form = (target === 'seller' ? screen.getByLabelText('氏名・名称') : content()).closest('form')!;
    const event = createEvent.submit(form);
    fireEvent(form, event);
    expect(event.defaultPrevented).toBe(true);
  });
});
