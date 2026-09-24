import { createHash } from 'node:crypto';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { X402DiscoveryView } from '@/components/X402DiscoveryView';
import { renderWithIntl } from '../_helpers/i18n';

// R10a (X402DiscoveryView の機械的分割) の網。分割前の component で全 test が通ることを確認してから
// 分割する: 全 DOM の hash (サインイン前後・節の並び・編集中)・コピー済み表示と展開状態の共有・
// 認証/アカウント切替を跨ぐ下書きと進行中の mutation・owned/公開カタログ両方の invalidate を固定する。

const auth = vi.hoisted(() => ({
  address: undefined as string | undefined,
  connected: false,
  signedIn: false,
  signingIn: false,
  signIn: vi.fn(async (_statement: string) => {}),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: auth.address, isConnected: auth.connected }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: auth.signedIn, isSigningIn: auth.signingIn, signIn: auth.signIn,
  }),
}));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect fixture</button>,
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableX402DualRailUi: true } };
});

const ADDRESS_A = '0x1111111111111111111111111111111111111111';
const ADDRESS_B = '0x2222222222222222222222222222222222222222';
const ITEM = {
  title: 'Catalog fixture', resource: 'https://example.com/api/paid/fixture',
  description: 'Catalog description', trigger: 'Buy when needed', category: 'data',
  priceJpyc: '101', docsUrl: 'https://example.com/docs', license: 'Catalog license',
  updatedAt: '2026-09-22T23:30:00Z', verifiedAt: '2026-09-23T00:00:00Z', official: true,
  usdc: { priceUsd: '0.02', serviceName: 'Fixture' },
  accepts: [{ extra: { openpay: { feeValue: '1010000000000000000' } } }],
};
const OWNED = {
  id: 'owned-a', title: 'Owned fixture', url: 'https://example.com/owned',
  description: 'Owned description', priceJpyc: '101', category: 'api', payTo: ADDRESS_A,
  docsUrl: 'https://example.com/docs', license: 'Owned license',
  hidden: true, paywallSnippet: 'fixture gate\nsecond line',
  usdc: { priceUsd: '0.02', payTo: ADDRESS_A, serviceName: 'Fixture' },
};
const OTHER = { ...OWNED, id: 'owned-b', title: 'Other account fixture', url: 'https://example.com/other', payTo: ADDRESS_B };
const USDC = [{ title: 'USDC fixture', resource: 'https://example.com/usdc', description: 'USDC description', category: 'data' as const, priceUsd: '0.01' }];
const URL_PLACEHOLDER = 'https://api.example.jp/paid/weather';
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function owner(address = ADDRESS_A) {
  auth.connected = true;
  auth.signedIn = true;
  auth.address = address;
}
function mount(locale: 'ja' | 'en' = 'ja', overrides: Partial<ComponentProps<typeof X402DiscoveryView>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <X402DiscoveryView
        maxResourcesPerMerchant={100}
        featured={<h2>Featured fixture</h2>}
        usdcItems={USDC}
        usdcArc
        freshnessByPath={{ '/api/paid/fixture': { latestEventDate: '2026-09-23', totalEvents: 42 } }}
        {...overrides}
      />
    </QueryClientProvider>
  );
  const view = renderWithIntl(tree(), { locale });
  return { ...view, qc, refresh: () => view.rerender(tree()) };
}
function catalogCard() {
  return screen.getByText('Catalog fixture').closest('li')!;
}
// 出品フォームの節 (サインイン前後・畳み込みの有無を問わず registerSubtitle は節の中にある)。
function registrationSection() {
  return screen.getByText('402 ゲートを置くだけ。エージェントが見つけて JPYC で支払い、受取は直接着金。').closest('section')!;
}
function detailsOf(summaryText: string) {
  return screen.getByText(summaryText).closest('details')!;
}
function hashDom(container: HTMLElement) {
  // 基準値は分割前 (origin/main) の component で採取した。DOM の bytes は正規化しない。
  // all = 全 DOM の sha256 (網の本体)。parts = 最上位の節ごとの短い hash と冒頭の文字で、落ちたときに
  // どの節が変わったかを snapshot の diff に出す補助 (all は弱めない)。行単位の差分が要るときは、ここで
  // 一時的に container.innerHTML を分割前後の両 tree で書き出して diff する。
  const sha256 = (html: string) => createHash('sha256').update(html).digest('hex');
  return {
    all: sha256(container.innerHTML),
    parts: [...container.firstElementChild!.children].map((el) => (
      `${el.tagName.toLowerCase()} ${sha256(el.outerHTML).slice(0, 12)} ${el.textContent!.slice(0, 16)}`
    )),
  };
}

beforeEach(() => {
  Object.assign(auth, { address: undefined, connected: false, signedIn: false, signingIn: false });
  auth.signIn.mockClear();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-24T12:00:00Z'));
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(
    url === '/api/discovery' ? { items: [ITEM] } : { resources: [OWNED] },
  )));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('R10a pre-extraction pinning', () => {
  async function captureDom(locale: 'ja' | 'en') {
    const view = mount(locale);
    const cold = hashDom(view.container);
    expect(screen.getByRole('button', { name: 'Connect fixture' })).toBeInTheDocument();
    await screen.findByText('Catalog fixture');
    const disconnected = hashDom(view.container);
    auth.connected = true;
    auth.address = ADDRESS_A;
    view.refresh();
    const connected = hashDom(view.container);
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    const registration = screen.getByPlaceholderText(URL_PLACEHOLDER).closest('section')!;
    await waitFor(() => expect(registration.querySelector('details')).not.toHaveAttribute('open'));
    const signedIn = hashDom(view.container);
    fireEvent.click(within(screen.getByText('Owned fixture').closest('li')!).getByRole('button', { name: locale === 'ja' ? '編集' : 'Edit' }));
    await waitFor(() => expect(registration.querySelector('details')).toHaveAttribute('open'));
    const editing = hashDom(view.container);
    return { cold, disconnected, connected, signedIn, editing };
  }

  it('pins complete ja DOM through cold render, auth and editing', async () => {
    expect(await captureDom('ja')).toMatchInlineSnapshot(`
      {
        "cold": {
          "all": "93e5bb5a23bc2b64cf410adffd7e2d51b817109243980f9dcfef41fe350ab7e0",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 7eb595383b28 カタログ発見: /api/dis",
            "section 8c7d8c34ff3b API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "connected": {
          "all": "8ee456494264f875391526dd18921e084091dabe6b78e1e1b4137147940aa32b",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section a5dd7e30b19f カタログ発見: /api/dis",
            "section 83a8d18bec60 API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "disconnected": {
          "all": "47c0a7c74cab91f985a3fa3b9da7813c9e4e301953e3c4a5f2336ccf154d4d56",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section a5dd7e30b19f カタログ発見: /api/dis",
            "section 8c7d8c34ff3b API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "editing": {
          "all": "3566b7096a6f2fd25ac9f9b952f183731cdfd6f1f6a0d03f0b21bf0842148eb7",
          "parts": [
            "section 163633ce2c10 あなたの登録登録済みの掲載を編集",
            "section 70b8061739f2 掲載を編集402 ゲートを置くだ",
            "h2 3282793f6040 Featured fixture",
            "section a5dd7e30b19f カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "signedIn": {
          "all": "f3d434b2eb5e8269540f3949946197f0af62ba2857f7f8ee86b8432eb89bd3b7",
          "parts": [
            "section 163633ce2c10 あなたの登録登録済みの掲載を編集",
            "section 1f4a5449a0ae 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section a5dd7e30b19f カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
      }
    `);
  });

  it('pins complete en DOM through cold render, auth and editing', async () => {
    expect(await captureDom('en')).toMatchInlineSnapshot(`
      {
        "cold": {
          "all": "179e1a054fb10cc7de5fedb0b1b328353f41854917a5c68de914e7e3274499ce",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section df5e32bfe387 CatalogDiscover ",
            "section 1db767b55ec3 List your APIPut",
            "section 9d6349975015 Try it for ¥2 (5",
            "section 8b0dcc299862 Pay from an agen",
          ],
        },
        "connected": {
          "all": "0528f5bc6cb3d6c4e460becbd593a3f088c78e98bda708b814e31614097345ec",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 698525d64c5d CatalogDiscover ",
            "section 0cfe16b4f7f5 List your APIPut",
            "section 9d6349975015 Try it for ¥2 (5",
            "section 8b0dcc299862 Pay from an agen",
          ],
        },
        "disconnected": {
          "all": "a5969083be43f639eeb0cb80737c4b7064cce35999485fa1740ccd35b2dda2d3",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 698525d64c5d CatalogDiscover ",
            "section 1db767b55ec3 List your APIPut",
            "section 9d6349975015 Try it for ¥2 (5",
            "section 8b0dcc299862 Pay from an agen",
          ],
        },
        "editing": {
          "all": "6c551403a4d40577c49985332f9e4d1e2bd58107e16578c4198d59fcc1ae6f37",
          "parts": [
            "section eba01b2d56b3 Your registratio",
            "section 9b8a4ab720a7 Edit listingPut ",
            "h2 3282793f6040 Featured fixture",
            "section 698525d64c5d CatalogDiscover ",
            "section 9d6349975015 Try it for ¥2 (5",
            "section 8b0dcc299862 Pay from an agen",
          ],
        },
        "signedIn": {
          "all": "977a8c13bbcb7052b03c341025f6131b76a6f27e49e58d2515c7075e83392dc3",
          "parts": [
            "section eba01b2d56b3 Your registratio",
            "section 4eb488786c83 List a new APIPu",
            "h2 3282793f6040 Featured fixture",
            "section 698525d64c5d CatalogDiscover ",
            "section 9d6349975015 Try it for ¥2 (5",
            "section 8b0dcc299862 Pay from an agen",
          ],
        },
      }
    `);
  });

  it('keeps connect/sign-in entry points, catalog filters, expansion and in-flight copy across auth transitions', async () => {
    const clipboard = deferred<void>();
    vi.mocked(navigator.clipboard.writeText).mockReturnValue(clipboard.promise);
    const view = mount();
    await screen.findByText('Catalog fixture');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Catalog' } });
    fireEvent.click(within(catalogCard()).getByRole('button', { name: '続きを読む' }));
    fireEvent.click(within(catalogCard()).getByRole('button', { name: 'コピー' }));
    auth.connected = true;
    auth.address = ADDRESS_A;
    view.refresh();
    fireEvent.click(screen.getByRole('button', { name: 'ウォレットでサインイン' }));
    expect(auth.signIn).toHaveBeenCalledOnce();
    expect(auth.signIn).toHaveBeenCalledWith('OpenPay x402 ファシリテーターにサインインします。');
    auth.signingIn = true;
    view.refresh();
    expect(screen.getByRole('button', { name: 'サインイン中…' })).toBeDisabled();
    auth.signingIn = false;
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    await act(async () => clipboard.resolve());
    expect(screen.getByRole('searchbox')).toHaveValue('Catalog');
    expect(within(catalogCard()).getByRole('button', { name: '閉じる' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(catalogCard()).getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
    expect(within(catalogCard()).getByText('利用条件: Catalog license')).toBeInTheDocument();
    // コピー済み表示は owner カードと公開カタログで 1 つを共有する (別カードのコピーで前の表示が消える)。
    vi.mocked(navigator.clipboard.writeText).mockResolvedValue();
    fireEvent.click(within(screen.getByText('Owned fixture').closest('li')!).getByLabelText('コピー'));
    await waitFor(() => expect(within(catalogCard()).getByRole('button', { name: 'コピー' })).toBeInTheDocument());
    auth.signedIn = false;
    view.refresh();
    expect(screen.queryByText('Owned fixture')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('Catalog');
    expect(within(catalogCard()).getByRole('button', { name: '閉じる' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('retains edit drafts across account/sign-in changes and resets only on cancel', async () => {
    owner();
    const pendingB = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/discovery') return reply({ items: [ITEM] });
      return auth.address === ADDRESS_B ? pendingB.promise : reply({ resources: [OWNED] });
    }));
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/draft' } });
    fireEvent.click(within(screen.getByText('Owned fixture').closest('li')!).getByRole('button', { name: '続きを読む' }));
    owner(ADDRESS_B);
    view.refresh();
    await waitFor(() => expect(view.qc.isFetching({ queryKey: ['x402', 'owned', ADDRESS_B] })).toBe(1));
    expect(screen.queryByText('Owned fixture')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('https://example.com/draft');
    await act(async () => pendingB.resolve(reply({ resources: [OTHER] })));
    await screen.findByText('Other account fixture');
    auth.signedIn = false;
    view.refresh();
    expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('https://example.com/draft');
    expect(within(screen.getByText('Owned fixture').closest('li')!).getByRole('button', { name: '閉じる' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('');
    expect(screen.queryByRole('button', { name: '更新する' })).not.toBeInTheDocument();
  });

  it('does not display a late owned response for the previous wallet', async () => {
    owner();
    const pendingA = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/discovery') return reply({ items: [ITEM] });
      return auth.address === ADDRESS_A ? pendingA.promise : reply({ resources: [OTHER] });
    }));
    const view = mount();
    await screen.findByText('Catalog fixture');
    owner(ADDRESS_B);
    view.refresh();
    await screen.findByText('Other account fixture');
    await act(async () => pendingA.resolve(reply({ resources: [OWNED] })));
    expect(screen.queryByText('Owned fixture')).not.toBeInTheDocument();
    expect(view.qc.getQueryData(['x402', 'owned', ADDRESS_A])).toEqual([OWNED]);
    expect(view.qc.getQueryData(['x402', 'owned', ADDRESS_B])).toEqual([OTHER]);
  });

  it.each(['POST', 'PATCH', 'DELETE'] as const)('pins in-flight %s wire bytes, feedback and invalidation across wallets', async (method) => {
    owner();
    const pendingMutation = deferred<Response>();
    const pendingCatalog = deferred<Response>();
    const pendingOwned = deferred<Response>();
    let completing = false;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return pendingMutation.promise;
      if (url === '/api/discovery') return completing ? pendingCatalog.promise : reply({ items: [ITEM] });
      return completing ? pendingOwned.promise : reply({ resources: auth.address === ADDRESS_A ? [OWNED] : [OTHER] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const view = mount();
    await screen.findByText('Owned fixture');
    if (method === 'POST') {
      fireEvent.click(screen.getByText('新しい API を出品する'));
      fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/new' } });
      fireEvent.click(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' }));
      fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    } else if (method === 'PATCH') {
      fireEvent.click(screen.getByRole('button', { name: '編集' }));
      fireEvent.click(screen.getByRole('button', { name: '更新する' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: '削除' }));
      fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    }
    await waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => init?.method === method)).toBe(true));
    const mutationCall = fetchFn.mock.calls.find(([, init]) => init?.method === method);
    expect(mutationCall).toEqual(method === 'DELETE'
      ? ['/api/facilitator/resources/owned-a', { method: 'DELETE' }]
      : [method === 'POST' ? '/api/facilitator/resources' : '/api/facilitator/resources/owned-a', {
          method, headers: { 'content-type': 'application/json' },
          body: method === 'POST'
            ? '{"url":"https://example.com/new","description":"","priceJpyc":"","category":"","attested":true}'
            : '{"url":"https://example.com/owned","description":"Owned description","priceJpyc":"101","category":"api","payTo":"0x1111111111111111111111111111111111111111","title":"Owned fixture","docsUrl":"https://example.com/docs","license":"Owned license","usdc":{"priceUsd":"0.02","payTo":"0x1111111111111111111111111111111111111111","serviceName":"Fixture"}}',
        }]);
    owner(ADDRESS_B);
    view.refresh();
    await screen.findByText('Other account fixture');
    if (method !== 'DELETE') expect(screen.getByRole('button', { name: method === 'POST' ? '登録中…' : '更新中…' })).toBeDisabled();
    const invalidate = vi.spyOn(view.qc, 'invalidateQueries');
    completing = true;
    await act(async () => pendingMutation.resolve(reply({ resource: OWNED, paywallSnippet: 'created gate' })));
    await waitFor(() => expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['x402', 'discovery'] }], [{ queryKey: ['x402', 'owned'] }],
    ]));
    expect(view.qc.getQueryState(['x402', 'owned', ADDRESS_A])?.isInvalidated).toBe(true);
    expect(screen.queryByText('Catalog fixture')).not.toBeInTheDocument();
    expect(view.container.querySelectorAll('.animate-pulse')).toHaveLength(2);
    await act(async () => {
      pendingCatalog.resolve(reply({ items: [{ ...ITEM, title: 'Refetched catalog' }] }));
      pendingOwned.resolve(reply({ resources: [OTHER] }));
    });
    await screen.findByText('Refetched catalog');
    expect(screen.getByText(method === 'POST' ? '登録しました。' : method === 'PATCH' ? '更新しました。' : '削除しました。')).toBeInTheDocument();
    if (method !== 'DELETE') expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('');
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  });

  it('pins DOM across catalog paging/filters and the owner register → gate error → created → owned flow', async () => {
    const catalogItems = [
      ITEM,
      ...Array.from({ length: 9 }, (_, i) => ({
        resource: i === 0 ? 'http://insecure.example/api' : `https://example.com/api/${i}`,
        description: i === 1 ? 'Long extra description. '.repeat(8).trim() : `Extra item ${i}`,
        category: ['api', 'mcp', 'content'][i % 3],
        priceJpyc: String(10 + i),
        accepts: i % 2 === 0 ? [{ extra: { openpay: { feeValue: '100000000000000000' } } }] : [],
        ...(i === 2 ? { usdc: { priceUsd: '0.5' } } : {}),
      })),
    ];
    let ownedList: unknown[] = [];
    const mutationReplies = [
      { ok: false, body: { error: 'gate_not_openpay', paywallSnippet: 'gate fixture snippet' } },
      { ok: true, body: { resource: { url: 'https://example.com/new' }, paywallSnippet: 'created fixture snippet' } },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const next = mutationReplies.shift()!;
        if (next.ok) {
          ownedList = [{
            ...OWNED, id: 'owned-new', title: 'Registered fixture', hidden: false,
            docsUrl: 'http://insecure.example/docs', license: undefined, usdc: undefined,
          }];
        }
        return reply(next.body, next.ok);
      }
      if (url === '/api/discovery') return reply({ items: catalogItems });
      return reply({ resources: ownedList });
    }));
    const view = mount('ja', { usdcArc: false, maxResourcesPerMerchant: 5, freshnessByPath: undefined });
    await screen.findByText('Catalog fixture');
    const dom: Record<string, ReturnType<typeof hashDom>> = { catalog: hashDom(view.container) };
    fireEvent.click(screen.getByRole('button', { name: 'さらに 3 件を表示' }));
    dom.shownMore = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: /^USDC\s*3$/ }));
    dom.usdcFilter = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: /^すべて\s*\d+$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^mcp\s*3$/ }));
    dom.category = hashDom(view.container);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz-no-match' } });
    dom.noResults = hashDom(view.container);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });

    owner();
    view.refresh();
    await waitFor(() => expect(view.qc.getQueryState(['x402', 'owned', ADDRESS_A])?.status).toBe('success'));
    dom.ownerEmpty = hashDom(view.container);
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/new' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'USDC (Base) でも販売する — x402 Bazaar に掲載' }));
    fireEvent.change(screen.getByPlaceholderText('0.005'), { target: { value: '0.01' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' }));
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    const gateSnippet = (await screen.findByText('gate fixture snippet')).parentElement!;
    dom.gateError = hashDom(view.container);
    fireEvent.click(within(gateSnippet).getByRole('button', { name: 'コピー' }));
    await within(gateSnippet).findByRole('button', { name: 'コピーしました' });
    dom.gateErrorCopied = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    await screen.findByText('Registered fixture');
    await waitFor(() => expect(view.qc.isFetching()).toBe(0));
    expect(screen.getByText('登録しました。')).toBeInTheDocument();
    dom.created = hashDom(view.container);
    const card = screen.getByText('Registered fixture').closest('li')!;
    fireEvent.click(within(card).getByRole('button', { name: 'スニペット' }));
    dom.snippetOpen = hashDom(view.container);
    fireEvent.click(within(card).getByRole('button', { name: '削除' }));
    dom.confirmDelete = hashDom(view.container);
    expect(dom).toMatchInlineSnapshot(`
      {
        "catalog": {
          "all": "8bc39c1cd4f5a773158b2662a8eeb81de321d628abdfe74ecb9a5e4a38ea565b",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section f3ec7cbbe610 カタログ発見: /api/dis",
            "section 8c7d8c34ff3b API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "category": {
          "all": "7671aed0e3e26416d5bc30b4072013f07eaeb4b7341c8dc9d218fe3be6f90486",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 255a19113439 カタログ発見: /api/dis",
            "section 8c7d8c34ff3b API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "confirmDelete": {
          "all": "58df58a66fb38da2538b5593835750887d5da1e52c11f87650ccece771d458c5",
          "parts": [
            "section 0d338cc1a4b0 あなたの登録登録済みの掲載を編集",
            "section c71477781525 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section 255a19113439 カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "created": {
          "all": "b54af7c168b475ba601f5807f910bf5e4956bb736c785829a567fa5047200277",
          "parts": [
            "section 1e3f78a9771a あなたの登録登録済みの掲載を編集",
            "section c71477781525 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section 255a19113439 カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "gateError": {
          "all": "e4f6dcd02e70f8279fccdf56daa63211a869bdb5458b82b9462a630d92512275",
          "parts": [
            "section bd900a39479a API を出品する402 ゲート",
            "h2 3282793f6040 Featured fixture",
            "section 255a19113439 カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "gateErrorCopied": {
          "all": "9527598579d5cb102fbf73fe344d0337ae86921c717ec3ac1c13a4fd8fdd2862",
          "parts": [
            "section 2283e888548f API を出品する402 ゲート",
            "h2 3282793f6040 Featured fixture",
            "section 255a19113439 カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "noResults": {
          "all": "8dd97b88ab0a866e9f5f5bfc700af7f86753215a12660e0fc2dfd5e126a17487",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 248c41c26dfe カタログ発見: /api/dis",
            "section 8c7d8c34ff3b API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "ownerEmpty": {
          "all": "97e5b2b3c0bca6390424ac98dd9f432dfafa0560dd62060e7eac49d736754df4",
          "parts": [
            "section 275e0bd94d7e API を出品する402 ゲート",
            "h2 3282793f6040 Featured fixture",
            "section 255a19113439 カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "shownMore": {
          "all": "8c15b54cd29cf8cdb05a76d6c9a93d0339a93c082de3b3df86e7a800ffd5e7d0",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 680eef52b733 カタログ発見: /api/dis",
            "section 8c7d8c34ff3b API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "snippetOpen": {
          "all": "629e8eac0456702c6988c9d3e8539837c65d91dcc5ce787d8b718fa860faf92c",
          "parts": [
            "section f1a2af18e74d あなたの登録登録済みの掲載を編集",
            "section c71477781525 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section 255a19113439 カタログ発見: /api/dis",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
        "usdcFilter": {
          "all": "19cfada087fd6f7ae03a77432c54e3ab376daa3eb3fda5b08f6e0bb88df625d7",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 5b5af37fb80a カタログ発見: /api/dis",
            "section 8c7d8c34ff3b API を出品する402 ゲート",
            "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
            "section 8ef5d8d9c7eb エージェントから払う (MCP)",
          ],
        },
      }
    `);
  });

  // 並び替えは型の異なる要素を同じ位置に置くので、サインイン/サインアウトのたびに featured・公開カタログ・
  // 出品フォームの節は作り直され、非制御の <details> 開閉と focus を失う。末尾の「試す」「MCP」の節は位置が
  // 変わらないので同じ node のまま開閉を保つ。分割前 (origin/main) の挙動をそのまま固定する (良し悪しの判断
  // ではない): panel に key を足す・並べ方や要素の型を変えると落ちる。
  it('pins which sections remount (losing uncontrolled <details> state and focus) at sign-in and sign-out', async () => {
    const view = mount();
    await screen.findByText('Catalog fixture');
    const nodes = () => ({
      featured: screen.getByText('Featured fixture'),
      catalog: screen.getByRole('searchbox').closest('section')!,
      registration: registrationSection(),
      guards: detailsOf('購入ガード'),
      search: screen.getByRole('searchbox'),
      tryIt: detailsOf('2円で試す (5分)'),
      mcp: detailsOf('エージェントから払う (MCP)'),
    });
    type Nodes = ReturnType<typeof nodes>;
    const openAndFocus = (n: Nodes) => {
      n.guards.open = true;
      n.tryIt.open = true;
      n.mcp.open = true;
      n.search.focus();
      expect(document.activeElement).toBe(n.search);
    };
    const expectRemountedAround = (before: Nodes, after: Nodes) => {
      for (const key of ['featured', 'catalog', 'registration', 'guards', 'search'] as const) {
        expect(after[key], key).not.toBe(before[key]);
        expect(before[key].isConnected, key).toBe(false);
      }
      expect(after.guards.open).toBe(false);
      expect(document.activeElement).toBe(document.body);
      expect(after.tryIt).toBe(before.tryIt);
      expect(after.mcp).toBe(before.mcp);
      expect(after.tryIt.open).toBe(true);
      expect(after.mcp.open).toBe(true);
    };
    const signedOut = nodes();
    openAndFocus(signedOut);
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    const signedIn = nodes();
    expectRemountedAround(signedOut, signedIn);
    openAndFocus(signedIn);
    auth.signedIn = false;
    view.refresh();
    expect(screen.queryByText('Owned fixture')).not.toBeInTheDocument();
    expectRemountedAround(signedIn, nodes());
  });

  // owned が 0 → 1 件になると出品フォームは <details> に畳まれ、中身 (入力欄) は作り直される (節自体は残る)。
  it('pins that the registration form content remounts when it folds into <details> (owned 0 → 1)', async () => {
    owner();
    const pendingOwned = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/discovery' ? reply({ items: [ITEM] }) : pendingOwned.promise
    )));
    mount();
    await screen.findByText('Catalog fixture');
    const section = registrationSection();
    const urlInput = screen.getByPlaceholderText(URL_PLACEHOLDER);
    expect(urlInput.closest('details')).toBeNull();
    urlInput.focus();
    await act(async () => pendingOwned.resolve(reply({ resources: [OWNED] })));
    await screen.findByText('Owned fixture');
    expect(registrationSection()).toBe(section);
    const folded = screen.getByPlaceholderText(URL_PLACEHOLDER);
    expect(folded).not.toBe(urlInput);
    expect(folded.closest('details')).not.toHaveAttribute('open');
    expect(document.activeElement).toBe(document.body);
  });

  // コピー済み表示は examples (試す / MCP) と公開カタログで 1 つを共有する: 別の場所をコピーすると前の表示は消える。
  it('shares one copied indicator between the examples (try / MCP) and the catalog cards', async () => {
    mount();
    await screen.findByText('Catalog fixture');
    const tryIt = detailsOf('2円で試す (5分)');
    const mcp = detailsOf('エージェントから払う (MCP)');
    fireEvent.click(within(mcp).getByRole('button', { name: 'コピー' }));
    await within(mcp).findByRole('button', { name: 'コピーしました' });
    expect(within(catalogCard()).getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    fireEvent.click(within(catalogCard()).getByRole('button', { name: 'コピー' }));
    await within(catalogCard()).findByRole('button', { name: 'コピーしました' });
    expect(within(mcp).getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    fireEvent.click(within(tryIt).getAllByRole('button', { name: 'コピー' })[0]);
    await within(tryIt).findByRole('button', { name: 'コピーしました' });
    expect(within(catalogCard()).getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    expect(within(mcp).getByRole('button', { name: 'コピー' })).toBeInTheDocument();
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls.map(([text]) => text.split('\n')[0])).toEqual([
      '{', 'https://example.com/api/paid/fixture', 'curl -i https://open-pay.jp/api/paid/demo',
    ]);
  });

  // hook の順序 = 公開カタログの query を owned の query より先に登録する (サインイン済みの初回 mount で固定)。
  it('registers and fetches the public catalog query before the owned query on a signed-in cold mount', async () => {
    owner();
    const view = mount();
    await screen.findByText('Owned fixture');
    expect(view.qc.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([
      ['x402', 'discovery'], ['x402', 'owned', ADDRESS_A],
    ]);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      '/api/discovery', '/api/facilitator/resources',
    ]);
  });

  it('pins the empty-catalog DOM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ items: [] })));
    const view = mount('ja', { usdcItems: [] });
    await waitFor(() => expect(view.qc.isFetching()).toBe(0));
    expect(screen.getByText('まだ登録されたリソースはありません。')).toBeInTheDocument();
    expect(hashDom(view.container)).toMatchInlineSnapshot(`
      {
        "all": "0ae0a946040c9116a85babb50a603a4f1101192f3973939ab4f8c0e4d6af74de",
        "parts": [
          "h2 3282793f6040 Featured fixture",
          "section 939d601ec80b カタログ発見: /api/dis",
          "section 8c7d8c34ff3b API を出品する402 ゲート",
          "section 39f00dd85a8a 2円で試す (5分)1 JPYC",
          "section 8ef5d8d9c7eb エージェントから払う (MCP)",
        ],
      }
    `);
  });
});
