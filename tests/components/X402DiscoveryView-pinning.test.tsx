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
// B-R10c: 下書きの破棄と古い mutation の UI 反映抑止・送信元だけの owned 無効化は意図して変更。
// DOM hash は R10a の値を保つ。

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
// この画面の <svg> はすべて lucide-react の icon。版更新で path data や既定の描画属性 (viewBox/stroke 等)、
// icon 名の改名で lucide が付ける class (lucide / lucide-*) が変わり、自前の code と無関係に hash が落ちる。
// そこで複製した tree の各 <svg> の子を空にし、属性は配置と a11y に効く class/width/height/role/aria-* だけ
// 残し、class からも lucide / lucide-* を外す (<svg> 自体と位置・自前の utility class は残す。R11b の QR の網と
// 同じ規則)。<svg> の外の DOM は bytes のまま (実 DOM は触らない)。
const SVG_KEPT_ATTR = /^(class|width|height|role|aria-.+)$/;
function withoutSvgInternals(root: HTMLElement) {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const svg of copy.querySelectorAll('svg')) {
    svg.replaceChildren();
    for (const { name } of [...svg.attributes]) if (!SVG_KEPT_ATTR.test(name)) svg.removeAttribute(name);
    const cls = svg.getAttribute('class');
    if (cls !== null) {
      svg.setAttribute('class', cls.split(/\s+/).filter((c) => c && c !== 'lucide' && !c.startsWith('lucide-')).join(' '));
    }
  }
  return copy;
}
function hashDom(container: HTMLElement) {
  // 基準値は分割前 (origin/main との merge-base) の component で採取した。<svg> の中身以外は正規化しない。
  // 基準値を意図して採り直すときは、基準にする code (分割の網なら分割前) で `npx vitest run -u <この file>` を
  // 実行して inline snapshot を更新し、同じ file が比較先の code でも書き換えなしで通ることを確かめる。
  // all = 全 DOM の sha256 (網の本体)。parts = 最上位の節ごとの短い hash と冒頭の文字で、落ちたときに
  // どの節が変わったかを snapshot の diff に出す補助 (all は弱めない)。行単位の差分が要るときは、ここで
  // 一時的に withoutSvgInternals(container).innerHTML を分割前後の両 tree で書き出して diff する。
  const sha256 = (html: string) => createHash('sha256').update(html).digest('hex');
  const dom = withoutSvgInternals(container);
  return {
    all: sha256(dom.innerHTML),
    parts: [...dom.firstElementChild!.children].map((el) => (
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
          "all": "47b659bdf5170297972f73c4d24f91f2b58b89fafafeb111d51dd87bebc68988",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section a211614bb375 カタログ発見: /api/dis",
            "section 4aebca8732f0 API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "connected": {
          "all": "85d3a9e4117229e3f53c97bc5956516b795d6457fe89eff3304e1bf129e90597",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section dd9b0d67eeae カタログ発見: /api/dis",
            "section 11a99a5e761d API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "disconnected": {
          "all": "e7a87916ae7f84f3cffd6289b3c8a7dd25ec324326e55d0708792a2bc77ac636",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section dd9b0d67eeae カタログ発見: /api/dis",
            "section 4aebca8732f0 API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "editing": {
          "all": "3b5adc298efd6c99574bb7ca84d2d2844a812005abb0a57602d3daef71ffc187",
          "parts": [
            "section 84703605eed1 あなたの登録登録済みの掲載を編集",
            "section 31746fad37e1 掲載を編集402 ゲートを置くだ",
            "h2 3282793f6040 Featured fixture",
            "section dd9b0d67eeae カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "signedIn": {
          "all": "5e714abe23281b5c7ac46e3bc51055371bc07457bb5599a8d30b5696449746f0",
          "parts": [
            "section 84703605eed1 あなたの登録登録済みの掲載を編集",
            "section b06f68f9c88e 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section dd9b0d67eeae カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
      }
    `);
  });

  it('pins complete en DOM through cold render, auth and editing', async () => {
    expect(await captureDom('en')).toMatchInlineSnapshot(`
      {
        "cold": {
          "all": "eb33156ed79514c32430db887612b6bbc4e84373d430667fe08fe5d48c66e719",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section ab55932553c8 CatalogDiscover ",
            "section 10cccfe6a706 List your APIPut",
            "section a1f8291dc9e1 Try it for ¥2A 1",
            "section f9ef500b2af9 Pay from an agen",
          ],
        },
        "connected": {
          "all": "3c997569089851f02934f587b566f2274f6fcdbc17250e2ba99e5b5c0ee2cef2",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section f780b219f7b8 CatalogDiscover ",
            "section 9b97e28051f0 List your APIPut",
            "section a1f8291dc9e1 Try it for ¥2A 1",
            "section f9ef500b2af9 Pay from an agen",
          ],
        },
        "disconnected": {
          "all": "f578813061791c34e650cc430df589c9686c55a05b1919c32a145ea381edee3c",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section f780b219f7b8 CatalogDiscover ",
            "section 10cccfe6a706 List your APIPut",
            "section a1f8291dc9e1 Try it for ¥2A 1",
            "section f9ef500b2af9 Pay from an agen",
          ],
        },
        "editing": {
          "all": "ed7a01d299f93fdbbd472c6b6d14e80771298717d39ad721103a919374468a3e",
          "parts": [
            "section 01e8bbeef899 Your registratio",
            "section 5e647a682509 Edit listingPut ",
            "h2 3282793f6040 Featured fixture",
            "section f780b219f7b8 CatalogDiscover ",
            "section a1f8291dc9e1 Try it for ¥2A 1",
            "section f9ef500b2af9 Pay from an agen",
          ],
        },
        "signedIn": {
          "all": "59aa11bf677fe3f4622bde68ed003e90cb1599ea5bac2e62405deaddc826c5ef",
          "parts": [
            "section 01e8bbeef899 Your registratio",
            "section 4b3f28bf78f6 List a new APIPu",
            "h2 3282793f6040 Featured fixture",
            "section f780b219f7b8 CatalogDiscover ",
            "section a1f8291dc9e1 Try it for ¥2A 1",
            "section f9ef500b2af9 Pay from an agen",
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

  it.each(['wallet switch', 'sign-out'] as const)('clears edit drafts and editId on %s (B-R10c)', async (transition) => {
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
    if (transition === 'wallet switch') {
      owner(ADDRESS_B);
      view.refresh();
      await waitFor(() => expect(view.qc.isFetching({ queryKey: ['x402', 'owned', ADDRESS_B] })).toBe(1));
      expect(screen.queryByText('Owned fixture')).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('');
      await act(async () => pendingB.resolve(reply({ resources: [OTHER] })));
      await screen.findByText('Other account fixture');
    } else {
      auth.signedIn = false;
      view.refresh();
      expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
      expect(screen.queryByText('掲載を編集')).not.toBeInTheDocument();
    }
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('');
    expect(screen.queryByRole('button', { name: '更新する' })).not.toBeInTheDocument();
    for (const input of registrationSection().querySelectorAll('input:not([type="checkbox"])')) {
      expect(input).toHaveValue('');
    }
    expect(screen.getByRole('checkbox', { name: 'USDC (Base) でも販売する — x402 Bazaar に掲載' })).not.toBeChecked();
    expect(within(screen.getByText('Owned fixture').closest('li')!).getByRole('button', { name: '閉じる' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '編集' }));
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

  it.each(['POST', 'PATCH', 'DELETE'] as const)('pins in-flight %s wire bytes, feedback and invalidation for the submitting wallet', async (method) => {
    owner();
    const pendingMutation = deferred<Response>();
    const pendingCatalog = deferred<Response>();
    const pendingOwned = deferred<Response>();
    let completing = false;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return pendingMutation.promise;
      if (url === '/api/discovery') return completing ? pendingCatalog.promise : reply({ items: [ITEM] });
      return completing ? pendingOwned.promise : reply({ resources: [OWNED] });
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
    if (method !== 'DELETE') expect(screen.getByRole('button', { name: method === 'POST' ? '登録中…' : '更新中…' })).toBeDisabled();
    const invalidate = vi.spyOn(view.qc, 'invalidateQueries');
    completing = true;
    await act(async () => pendingMutation.resolve(reply({ resource: OWNED, paywallSnippet: 'created gate' })));
    await waitFor(() => expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['x402', 'discovery'] }], [{ queryKey: ['x402', 'owned', ADDRESS_A] }],
    ]));
    expect(view.qc.getQueryState(['x402', 'owned', ADDRESS_A])?.isInvalidated).toBe(true);
    expect(screen.queryByText('Catalog fixture')).not.toBeInTheDocument();
    expect(view.container.querySelectorAll('.animate-pulse')).toHaveLength(2);
    await act(async () => {
      pendingCatalog.resolve(reply({ items: [{ ...ITEM, title: 'Refetched catalog' }] }));
      pendingOwned.resolve(reply({ resources: [OWNED] }));
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
          "all": "1b2c4a516c6cf6b9990c09d6d92b9acf281f0bbca7c9c54563c6dd473448a4e5",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 9ad10c8006d7 カタログ発見: /api/dis",
            "section 4aebca8732f0 API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "category": {
          "all": "a45a68124d66f2880dc617cc8c5d0ed56868c26ef0a82d163ce0424cdd1a2055",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 08658fa17ca5 カタログ発見: /api/dis",
            "section 4aebca8732f0 API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "confirmDelete": {
          "all": "d5ccc0c9e5ed4388adfcf2914948be5ad101da6f488ad06d11bebbbf2ae9b5b3",
          "parts": [
            "section 0110dfa05888 あなたの登録登録済みの掲載を編集",
            "section 6a4aea4e7945 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section 08658fa17ca5 カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "created": {
          "all": "6ed07779d70fa0c8a0614c0d3809b371d170408bf11144112a3321fac7f0bc98",
          "parts": [
            "section 0f61c4f24311 あなたの登録登録済みの掲載を編集",
            "section 6a4aea4e7945 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section 08658fa17ca5 カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "gateError": {
          "all": "809e4040673b1c099eecfac2ac6410cb7d3fb91eec98a6862d9eb3a19f0f38fb",
          "parts": [
            "section 40e1101c8a4b API を出品する402 ゲート",
            "h2 3282793f6040 Featured fixture",
            "section 08658fa17ca5 カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "gateErrorCopied": {
          "all": "4d21b023680af39c71e3ba421ed456390e4ca276d8eac2d777e4d6117bb6c868",
          "parts": [
            "section b7fa88a6bee1 API を出品する402 ゲート",
            "h2 3282793f6040 Featured fixture",
            "section 08658fa17ca5 カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "noResults": {
          "all": "5918c10bd0dc5650c08a789af4daad6be7ed699a7a0be906ced448dd9647ec7f",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 791a15eb8f7b カタログ発見: /api/dis",
            "section 4aebca8732f0 API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "ownerEmpty": {
          "all": "55599d460926baa490e9a4e2b4bbfc6720cb18e943b811ff959e2f7330de5c0e",
          "parts": [
            "section 49ecc65baa39 API を出品する402 ゲート",
            "h2 3282793f6040 Featured fixture",
            "section 08658fa17ca5 カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "shownMore": {
          "all": "3398691f8511350469d81bdf2d580319aeb56500194d5d4353e5e369c8a162be",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 4a0bb42f32b0 カタログ発見: /api/dis",
            "section 4aebca8732f0 API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "snippetOpen": {
          "all": "401d9dde45abdac89dae2b3970e56646ab7756626d2e1e19b1919e4b2074ad6f",
          "parts": [
            "section 3382428b4640 あなたの登録登録済みの掲載を編集",
            "section 6a4aea4e7945 新しい API を出品する402",
            "h2 3282793f6040 Featured fixture",
            "section 08658fa17ca5 カタログ発見: /api/dis",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
          ],
        },
        "usdcFilter": {
          "all": "1abc8c863e2a0d9cf5a4fb2a51e29a98dcc3c27446c21b2f41892076b5b94b2b",
          "parts": [
            "h2 3282793f6040 Featured fixture",
            "section 3893e6bac7f7 カタログ発見: /api/dis",
            "section 4aebca8732f0 API を出品する402 ゲート",
            "section 518a148738f7 2円で試す1 JPYC + 手数",
            "section ad484573ea4a エージェントから払う (MCP)",
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
      tryIt: detailsOf('2円で試す'),
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
    const tryIt = detailsOf('2円で試す');
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
        "all": "4faa33f05a64d4e88f4eb3527547fd90a03a30921923420856b1d23a46c1a4f1",
        "parts": [
          "h2 3282793f6040 Featured fixture",
          "section 2ced173074d3 カタログ発見: /api/dis",
          "section 4aebca8732f0 API を出品する402 ゲート",
          "section 518a148738f7 2円で試す1 JPYC + 手数",
          "section ad484573ea4a エージェントから払う (MCP)",
        ],
      }
    `);
  });
});

// B-R10c: 送信後の React 再描画を挟み、最新の hook options に置き換わっても送信時の文脈を保つ。
describe('B-R10c owner mutation regressions', () => {
  function startMutation(method: 'POST' | 'PATCH' | 'DELETE', usdc = false) {
    if (method === 'POST') {
      fireEvent.click(screen.getByText('新しい API を出品する'));
      fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/new' } });
      if (usdc) {
        fireEvent.click(screen.getByRole('checkbox', { name: 'USDC (Base) でも販売する — x402 Bazaar に掲載' }));
        fireEvent.change(screen.getByPlaceholderText('0.005'), { target: { value: '0.02' } });
      }
      fireEvent.click(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' }));
      fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    } else if (method === 'PATCH') {
      fireEvent.click(screen.getByRole('button', { name: '編集' }));
      fireEvent.click(screen.getByRole('button', { name: '更新する' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: '削除' }));
      fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    }
  }

  describe.each(['POST', 'PATCH', 'DELETE'] as const)('%s', (method) => {
    it.each([
      ['wallet switch', true], ['wallet switch', false],
      ['re-sign-in', true], ['re-sign-in', false],
    ] as const)('ignores stale UI completion after %s (ok=%s), but refreshes successful writes', async (transition, ok) => {
      owner();
      const pending = deferred<Response>();
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) return pending.promise;
        if (url === '/api/discovery') return reply({ items: [ITEM] });
        return reply({ resources: auth.address === ADDRESS_A ? [OWNED] : [OTHER] });
      });
      vi.stubGlobal('fetch', fetchFn);
      const view = mount();
      await screen.findByText('Owned fixture');
      startMutation(method);
      await waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => init?.method === method)).toBe(true));
      if (transition === 'wallet switch') owner(ADDRESS_B);
      else auth.signedIn = false;
      view.refresh();
      if (transition === 're-sign-in') {
        // 完了前に再ログインする。完了後だと clearing effect が古い error を消し、guard 欠落を見逃す。
        owner();
        view.refresh();
      }
      await screen.findByText(transition === 'wallet switch' ? 'Other account fixture' : 'Owned fixture');
      await waitFor(() => expect(view.qc.isFetching()).toBe(0));
      fireEvent.click(screen.getByRole('button', { name: '編集' }));
      fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/current-draft' } });
      const invalidate = vi.spyOn(view.qc, 'invalidateQueries');
      const callsBeforeCompletion = fetchFn.mock.calls.length;
      await act(async () => pending.resolve(reply(ok
        ? { resource: OWNED, paywallSnippet: 'old wallet success snippet' }
        : { error: 'gate_not_openpay', paywallSnippet: 'old wallet error snippet' }, ok)));
      await waitFor(() => expect(view.qc.isMutating()).toBe(0));
      await waitFor(() => expect(view.qc.isFetching()).toBe(0));
      expect(invalidate.mock.calls).toEqual(ok ? [
        [{ queryKey: ['x402', 'discovery'] }], [{ queryKey: ['x402', 'owned', ADDRESS_A] }],
      ] : []);
      // B の active owned は再取得しない。A に戻っていれば catalog と A の owned の両方を再取得する。
      expect(fetchFn.mock.calls.slice(callsBeforeCompletion).map(([url]) => url)).toEqual(
        !ok ? [] : transition === 'wallet switch' ? ['/api/discovery'] : ['/api/discovery', '/api/facilitator/resources'],
      );
      if (transition === 'wallet switch') {
        expect(view.qc.getQueryState(['x402', 'owned', ADDRESS_A])?.isInvalidated).toBe(ok);
        expect(view.qc.getQueryState(['x402', 'owned', ADDRESS_B])?.isInvalidated).toBe(false);
      }
      expect(screen.queryByText(/^(登録しました。|更新しました。|削除しました。)$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/操作に失敗しました/)).not.toBeInTheDocument();
      expect(screen.queryByText('old wallet success snippet')).not.toBeInTheDocument();
      expect(screen.queryByText('old wallet error snippet')).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('https://example.com/current-draft');
      expect(screen.getByRole('button', { name: '更新する' })).toBeEnabled();
    });
  });

  it('shows the existing error UI for a rejected DELETE fetch and permits retry', async () => {
    owner();
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        if (++attempts === 1) throw new TypeError('Failed to fetch');
        return reply({ ok: true });
      }
      return reply(url === '/api/discovery' ? { items: [ITEM] } : { resources: [OWNED] });
    }));
    const view = mount();
    await screen.findByText('Owned fixture');
    const invalidate = vi.spyOn(view.qc, 'invalidateQueries');
    startMutation('DELETE');
    expect(await screen.findByText('操作に失敗しました (error)。')).toBeVisible();
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByText('削除しました。')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await screen.findByText('削除しました。');
    expect(screen.queryByText('操作に失敗しました (error)。')).not.toBeInTheDocument();
    expect(attempts).toBe(2);
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['x402', 'discovery'] }], [{ queryKey: ['x402', 'owned', ADDRESS_A] }],
    ]);
  });

  describe.each(['POST', 'PATCH', 'DELETE'] as const)('completed %s feedback', (method) => {
    it.each(['wallet switch', 'sign-out'] as const)('clears success, snippet and reminder on %s', async (transition) => {
      owner();
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) return reply({ resource: OWNED, paywallSnippet: 'completed A gate' });
        if (url === '/api/discovery') return reply({ items: [ITEM] });
        return reply({ resources: auth.address === ADDRESS_A ? [OWNED] : [OTHER] });
      }));
      const view = mount();
      await screen.findByText('Owned fixture');
      startMutation(method, true);
      const success = method === 'POST' ? '登録しました。' : method === 'PATCH' ? '更新しました。' : '削除しました。';
      expect(await screen.findByText(success)).toBeVisible();
      if (method === 'POST') expect(screen.getByText('completed A gate')).toBeVisible();
      if (method !== 'DELETE') expect(screen.getByText(/^USDC で販売するには、サーバーのゲートを/)).toBeVisible();
      await waitFor(() => expect(view.qc.isFetching()).toBe(0));

      if (transition === 'wallet switch') owner(ADDRESS_B);
      else auth.signedIn = false;
      view.refresh();
      if (transition === 'wallet switch') await screen.findByText('Other account fixture');
      expect(screen.queryByText(success)).not.toBeInTheDocument();
      expect(screen.queryByText('completed A gate')).not.toBeInTheDocument();
      expect(screen.queryByText(/^USDC で販売するには、サーバーのゲートを/)).not.toBeInTheDocument();
      owner();
      view.refresh();
      await screen.findByText('Owned fixture');
      expect(screen.queryByText(success)).not.toBeInTheDocument();
      expect(screen.queryByText('completed A gate')).not.toBeInTheDocument();
      expect(screen.queryByText(/^USDC で販売するには、サーバーのゲートを/)).not.toBeInTheDocument();
    });
  });

  it.each(['wallet switch', 'sign-out'] as const)('clears attestation, new draft and delete confirmation across %s and return', async (transition) => {
    owner();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url === '/api/discovery'
      ? { items: [ITEM] } : { resources: auth.address === ADDRESS_A ? [OWNED] : [OTHER] })));
    const view = mount();
    await screen.findByText('Owned fixture');
    fireEvent.click(screen.getByText('新しい API を出品する'));
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/unsubmitted' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' }));
    expect(screen.getByRole('button', { name: '登録する' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(screen.getByRole('button', { name: '削除する' })).toBeVisible();
    if (transition === 'wallet switch') owner(ADDRESS_B);
    else auth.signedIn = false;
    view.refresh();
    if (transition === 'wallet switch') {
      await screen.findByText('Other account fixture');
      expect(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' })).not.toBeChecked();
    }
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '登録する' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '削除する' })).not.toBeInTheDocument();
  });

  it('keeps the edit draft through wallet lock and unlock with the same SIWE session', async () => {
    owner();
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/locked-draft' } });
    Object.assign(auth, { address: undefined, connected: false, signedIn: false });
    view.refresh();
    expect(screen.getByRole('button', { name: 'Connect fixture' })).toBeVisible();
    expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('https://example.com/locked-draft');
    expect(screen.getByRole('button', { name: '更新する' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'USDC (Base) でも販売する — x402 Bazaar に掲載' })).toBeChecked();
  });

  it.each([ADDRESS_A, ADDRESS_B])('clears the draft when reconnecting %s without a matching SIWE session', async (address) => {
    owner();
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: '編集' }));
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/signed-out-draft' } });
    Object.assign(auth, { address: undefined, connected: false, signedIn: false });
    view.refresh();
    Object.assign(auth, { address, connected: true, signedIn: false });
    view.refresh();
    expect(screen.queryByText('掲載を編集')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ウォレットでサインイン' })).toBeInTheDocument();
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('');
    expect(screen.queryByRole('button', { name: '更新する' })).not.toBeInTheDocument();
  });

  it.each([
    ['POST', 'while locked'], ['POST', 'after unlock'],
    ['PATCH', 'while locked'], ['PATCH', 'after unlock'],
  ] as const)('keeps the in-flight %s result completed %s', async (method, completion) => {
    owner();
    const pending = deferred<Response>();
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return pending.promise;
      return reply(url === '/api/discovery' ? { items: [ITEM] } : { resources: [OWNED] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const view = mount();
    await screen.findByText('Owned fixture');
    startMutation(method, true);
    await waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => init?.method === method)).toBe(true));
    Object.assign(auth, { address: undefined, connected: false, signedIn: false });
    view.refresh();
    expect(screen.queryByPlaceholderText(URL_PLACEHOLDER)).not.toBeInTheDocument();
    if (completion === 'after unlock') {
      owner();
      view.refresh();
    }
    const invalidate = vi.spyOn(view.qc, 'invalidateQueries');
    await act(async () => pending.resolve(reply({ resource: OWNED, paywallSnippet: 'locked gate' })));
    await waitFor(() => expect(view.qc.isMutating()).toBe(0));
    if (completion === 'while locked') {
      owner();
      view.refresh();
    }
    expect(await screen.findByText(method === 'POST' ? '登録しました。' : '更新しました。')).toBeVisible();
    expect(screen.getByText(/^USDC で販売するには、サーバーのゲートを/)).toBeVisible();
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('');
    if (method === 'POST') expect(screen.getByText('locked gate')).toBeVisible();
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['x402', 'discovery'] }], [{ queryKey: ['x402', 'owned', ADDRESS_A] }],
    ]);
  });

  it('refreshes a completed POST after A→B→A without resetting a new draft, and resubmits the listing as PATCH without 409', async () => {
    owner();
    const pending = deferred<Response>();
    const registered = { ...OWNED, id: 'registered-a', title: 'New A listing', url: 'https://example.com/new', hidden: false };
    const resources = [OWNED];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body));
        if (resources.some((resource) => resource.url === payload.url)) {
          return new Response(JSON.stringify({ error: 'url_taken' }), { status: 409 });
        }
        return pending.promise;
      }
      if (init?.method === 'PATCH') return reply({ resource: registered });
      if (url === '/api/discovery') return reply({ items: [ITEM] });
      return reply({ resources: auth.address === ADDRESS_A ? [...resources] : [OTHER] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const view = mount();
    await screen.findByText('Owned fixture');
    startMutation('POST', true);
    await waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    owner(ADDRESS_B);
    view.refresh();
    await screen.findByText('Other account fixture');
    owner();
    view.refresh();
    await screen.findByText('Owned fixture');
    await waitFor(() => expect(view.qc.isFetching()).toBe(0));
    fireEvent.click(screen.getByText('新しい API を出品する'));
    fireEvent.change(screen.getByPlaceholderText(URL_PLACEHOLDER), { target: { value: 'https://example.com/next-draft' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' }));
    const invalidate = vi.spyOn(view.qc, 'invalidateQueries');
    resources.push(registered);
    await act(async () => pending.resolve(reply({ resource: registered, paywallSnippet: 'old A result gate' })));
    await waitFor(() => expect(view.qc.isMutating()).toBe(0));
    await screen.findByText('New A listing');
    expect(screen.queryByText('登録しました。')).not.toBeInTheDocument();
    expect(screen.queryByText('old A result gate')).not.toBeInTheDocument();
    expect(screen.queryByText(/^USDC で販売するには、サーバーのゲートを/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(URL_PLACEHOLDER)).toHaveValue('https://example.com/next-draft');
    expect(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' })).toBeChecked();
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['x402', 'discovery'] }], [{ queryKey: ['x402', 'owned', ADDRESS_A] }],
    ]);
    // owned に反映された掲載を編集できるので、同じ URL を再 POST して url_taken にする必要がない。
    fireEvent.click(within(screen.getByText('New A listing').closest('li')!).getByRole('button', { name: '編集' }));
    fireEvent.click(screen.getByRole('button', { name: '更新する' }));
    await screen.findByText('更新しました。');
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method).map(([url, init]) => [url, init?.method])).toEqual([
      ['/api/facilitator/resources', 'POST'], ['/api/facilitator/resources/registered-a', 'PATCH'],
    ]);
    expect(screen.queryByText(/操作に失敗しました/)).not.toBeInTheDocument();
  });

  it.each([
    ['POST', true], ['POST', false], ['PATCH', true], ['PATCH', false],
  ] as const)('uses submitted USDC enabled=%s/%s for the reminder after toggling during fetch', async (method, submittedUsdc) => {
    owner();
    const pending = deferred<Response>();
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return pending.promise;
      return reply(url === '/api/discovery' ? { items: [ITEM] } : { resources: [OWNED] });
    });
    vi.stubGlobal('fetch', fetchFn);
    const view = mount();
    await screen.findByText('Owned fixture');
    if (method === 'PATCH') fireEvent.click(screen.getByRole('button', { name: '編集' }));
    else {
      fireEvent.click(screen.getByText('新しい API を出品する'));
      fireEvent.click(screen.getByRole('checkbox', { name: '正当な権利と支払い制限を確認しました' }));
    }
    const checkbox = screen.getByRole('checkbox', { name: 'USDC (Base) でも販売する — x402 Bazaar に掲載' });
    if ((checkbox as HTMLInputElement).checked !== submittedUsdc) fireEvent.click(checkbox);
    if (submittedUsdc) fireEvent.change(screen.getByPlaceholderText('0.005'), { target: { value: '0.02' } });
    fireEvent.click(screen.getByRole('button', { name: method === 'POST' ? '登録する' : '更新する' }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => init?.method === method)).toBe(true));
    const body = JSON.parse(String(fetchFn.mock.calls.find(([, init]) => init?.method === method)![1]!.body));
    expect(Boolean(body.usdc)).toBe(submittedUsdc);
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(!submittedUsdc);
    await act(async () => pending.resolve(reply({ resource: OWNED, paywallSnippet: 'gate' })));
    await screen.findByText(method === 'POST' ? '登録しました。' : '更新しました。');
    await waitFor(() => expect(view.qc.isMutating()).toBe(0));
    expect(Boolean(screen.queryByText(/^USDC で販売するには、サーバーのゲートを/))).toBe(submittedUsdc);
  });
});
