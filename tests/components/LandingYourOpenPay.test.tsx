import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { act, type ReactElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ja from '../../messages/ja.json';
import { localDateKey, TODAY_SUMMARY_KEY } from '@/lib/history';

// wagmi の接続状態を test ごとに切り替える。
const account = vi.hoisted(() => ({ address: undefined as string | undefined, status: 'disconnected' as string }));
vi.mock('wagmi', () => ({ useAccount: () => account }));
// SIWE のセッション (ヘッダと同じ hook)。サインインの有無を test ごとに切り替える。
const siwe = vi.hoisted(() => ({ isSignedIn: false, sessionAddress: null as string | null }));
vi.mock('@/hooks/useSiweSession', () => ({ useSiweSession: () => siwe }));
const flags = vi.hoisted(() => ({ enableHandles: true, enableOrderRelay: true, enableShopLive: false, enableMobileOrder: true }));
vi.mock('@/lib/env', () => ({ env: flags }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async () => createTranslator({ locale: 'ja', messages: ja, namespace: 'Landing' }),
}));

import { LandingYourOpenPay } from '@/components/LandingYourOpenPay';
import { YourOpenPayFrame, YourOpenPayPage } from '@/components/LandingYourOpenPayClient';
import { handleViewTheme } from '@/lib/handleTheme';
import { RETURNING_WALLET_PREPAINT, WAGMI_STORE_KEY, resetReturningWalletForTest } from '@/hooks/useReturningWallet';

const SHOP = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const GLOBAL = '__openpayReturningWallet';
const win = window as unknown as Record<string, unknown>;
let queryClient: QueryClient;

function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="ja" messages={ja}>
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}
const renderStrip = (ui: ReactElement) => render(ui, { wrapper: Providers });

// ヘッダの「接続」と同じ wagmi の connect 操作 (mutationKey ['connect']) が成功したことを再現する。
async function userConnects() {
  await act(async () => {
    await queryClient.getMutationCache().build(queryClient, { mutationKey: ['connect'], mutationFn: async () => 'ok' }).execute(undefined);
  });
}

function storeToday(address: string, count = 8) {
  const summary = {
    date: localDateKey(Date.now()),
    byMerchant: { [address.toLowerCase()]: { count, jpycAtomic: '12300000000000000000000', usdcAtomic: '0', lastTs: Date.now() } },
  };
  window.localStorage.setItem(TODAY_SUMMARY_KEY, JSON.stringify(summary));
}

function runPrepaint(parent: HTMLElement) {
  // jsdom は inline script を実行しないので、同じ文字列を currentScript を差し替えて実行する。
  const script = document.createElement('script');
  parent.appendChild(script);
  const desc = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
  try {
    new Function(RETURNING_WALLET_PREPAINT)();
  } finally {
    if (desc) Object.defineProperty(document, 'currentScript', desc);
    else delete (document as unknown as Record<string, unknown>).currentScript;
  }
}

beforeEach(() => {
  queryClient = new QueryClient();
  window.localStorage.clear();
  delete win[GLOBAL];
  resetReturningWalletForTest();
  account.address = undefined;
  account.status = 'disconnected';
  siwe.isSignedIn = false;
  siwe.sessionAddress = null;
  Object.assign(flags, { enableHandles: true, enableOrderRelay: true, enableShopLive: false, enableMobileOrder: true });
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('描画前 script (再訪の目印)', () => {
  it('前回つないだまま離れた端末 (wagmi.store の state.current) だけ、描画前に枠を出す', () => {
    const parent = document.createElement('div');
    window.localStorage.setItem(WAGMI_STORE_KEY, JSON.stringify({ state: { connections: { __type: 'Map', value: [] }, chainId: 137, current: 'uid-1' }, version: 2 }));
    runPrepaint(parent);
    expect(parent.getAttribute('data-returning')).toBe('yes');
    expect(win[GLOBAL]).toBe(true);
  });
  it('切断済み・初回・壊れた JSON・localStorage の例外では出さず、例外も外へ出さない', () => {
    for (const raw of [JSON.stringify({ state: { current: null }, version: 2 }), null, '{not json']) {
      window.localStorage.clear();
      delete win[GLOBAL];
      if (raw !== null) window.localStorage.setItem(WAGMI_STORE_KEY, raw);
      const parent = document.createElement('div');
      expect(() => runPrepaint(parent)).not.toThrow();
      expect(parent.hasAttribute('data-returning')).toBe(false);
      expect(win[GLOBAL]).not.toBe(true);
    }
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const parent = document.createElement('div');
    expect(() => runPrepaint(parent)).not.toThrow();
    expect(parent.hasAttribute('data-returning')).toBe(false);
    spy.mockRestore();
  });
});

describe('YourOpenPayFrame (枠を出すか)', () => {
  const frame = () => document.querySelector('[data-returning]');

  // server の HTML (属性なし + 描画前 script) を置き、script の働きを再現してから hydrate する。
  async function hydrate(returning: boolean): Promise<{ el: HTMLElement; root: Root; rerender: () => Promise<void> }> {
    const tree = () => (
      <Providers>
        <YourOpenPayFrame>strip</YourOpenPayFrame>
      </Providers>
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree());
    document.body.appendChild(container);
    const el = container.querySelector('div') as HTMLElement;
    expect(el.hasAttribute('data-returning')).toBe(false);
    expect(container.querySelector('script')?.textContent).toBe(RETURNING_WALLET_PREPAINT);
    win[GLOBAL] = returning;
    if (returning) el.setAttribute('data-returning', 'yes');
    // RTL を通さない hydrateRoot なので、act を使える環境だと React に伝える。
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let root!: Root;
    await act(async () => {
      root = hydrateRoot(container, tree());
    });
    const rerender = async () => {
      await act(async () => {
        root.render(tree());
      });
    };
    return { el, root, rerender };
  }

  it('静的 HTML から hydrate したときは描画前 script の結果を引き継ぐ (再接続に失敗しても消さない = 押し上げない)', async () => {
    const { el, rerender } = await hydrate(true);
    expect(el).toHaveAttribute('data-returning', 'yes');
    // hydration が済んだら script は DOM から外す。
    expect(el.querySelector('script')).toBeNull();
    account.status = 'disconnected';
    await rerender();
    expect(el).toHaveAttribute('data-returning', 'yes');
  });
  it('目印のない訪問者は、自動の再接続でつながっても後から出さない (ヒーローより前に差し込まない)', async () => {
    const { el, rerender } = await hydrate(false);
    expect(el).toHaveAttribute('data-returning', 'no');
    account.status = 'connecting';
    await rerender();
    account.status = 'connected';
    account.address = SHOP;
    await rerender();
    expect(el).toHaveAttribute('data-returning', 'no');
  });
  it('このページで user がつないだら出す (ヘッダの connect 操作が成功したあと)', async () => {
    const { el, rerender } = await hydrate(false);
    await userConnects();
    account.status = 'connected';
    account.address = SHOP;
    await rerender();
    expect(el).toHaveAttribute('data-returning', 'yes');
  });
  it('帯を出す前の connect 操作 (前のページでつないだ分) は数えない', async () => {
    await queryClient.getMutationCache().build(queryClient, { mutationKey: ['connect'], mutationFn: async () => 'ok' }).execute(undefined);
    await new Promise((r) => setTimeout(r, 5));
    account.status = 'connected';
    const { el } = await hydrate(false);
    expect(el).toHaveAttribute('data-returning', 'no');
  });
  it('アプリ内の移動で来た帯は、読み込み時の script の結果を持ち越さず、mount の時点の接続で決める', () => {
    // この document で最初の帯 (hydration 済み) を一度出してから外す。
    win[GLOBAL] = true;
    const first = renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
    first.unmount();
    // 戻ってきた帯: 未接続なら出さない (script の結果 true は使わない)。
    const again = renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'no');
    expect(document.querySelector('script')).toBeNull();
    again.unmount();
    // つながったまま戻ってきたら最初から出す。
    account.status = 'connected';
    account.address = SHOP;
    renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
  });
  it('ほかの場所の hydration の失敗で client が描き直しても、この document で最初の帯は script の結果を使う', () => {
    win[GLOBAL] = true;
    renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
  });
});

describe('LandingYourOpenPay (中身)', () => {
  it('道具への近道は見えている名前で並び、未接続では今日の売上を出さない', async () => {
    storeToday(SHOP);
    renderStrip(await LandingYourOpenPay());
    const nav = screen.getByRole('region', { name: ja.Landing.yourOpenPayTitle });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/ja/create?tab=qr',
      '/ja/create?tab=register',
      '/ja/create?tab=orders',
      '/ja/history',
      '/ja/create?tab=profile',
    ]);
    expect(links[0]).toHaveTextContent(ja.Landing.yourOpenPayToolQr);
    expect(nav.querySelector('[aria-label]')).toBeNull();
    expect(within(nav).queryByText(ja.Landing.yourOpenPayToday)).toBeNull();
  });
  it('つながっているときだけ、そのアドレスの今日の売上を見出しの行に出す', async () => {
    storeToday(SHOP);
    account.status = 'connected';
    account.address = SHOP;
    renderStrip(await LandingYourOpenPay());
    const pill = screen.getByText(ja.Landing.yourOpenPayToday).closest('a');
    expect(pill).toHaveAttribute('href', '/ja/history');
    expect(pill).toHaveTextContent('¥12,300');
    expect(pill).toHaveTextContent('8 件');
  });
  it('再接続の途中・別のアドレスでは売上を出さない', async () => {
    storeToday(SHOP);
    account.status = 'reconnecting';
    account.address = SHOP;
    const { unmount } = renderStrip(await LandingYourOpenPay());
    expect(screen.queryByText(ja.Landing.yourOpenPayToday)).toBeNull();
    unmount();
    account.status = 'connected';
    account.address = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
    renderStrip(await LandingYourOpenPay());
    expect(screen.queryByText(ja.Landing.yourOpenPayToday)).toBeNull();
  });
  it('flag で道具が決まる (注文の一覧がなければモバイルオーダーの設定・どちらもなければ 3 つ・handle OFF なら自分のページなし)', async () => {
    Object.assign(flags, { enableOrderRelay: false, enableShopLive: false, enableMobileOrder: true, enableHandles: false });
    const { unmount } = renderStrip(await LandingYourOpenPay());
    let links = within(screen.getByRole('region')).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/ja/create?tab=qr', '/ja/create?tab=register', '/ja/create?tab=mobileOrder', '/ja/history']);
    unmount();
    Object.assign(flags, { enableMobileOrder: false });
    renderStrip(await LandingYourOpenPay());
    links = within(screen.getByRole('region')).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/ja/create?tab=qr', '/ja/create?tab=register', '/ja/history']);
  });
});

describe('YourOpenPayPage (自分のページ・P4b)', () => {
  const OWNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
  const page = () => (
    <YourOpenPayPage fallback={<a href="#default-row">既定の行</a>} pageLabel={ja.Landing.yourOpenPayPageTitle} editLabel={ja.Landing.yourOpenPayPageEdit} />
  );
  function mockHandles(body: unknown, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }
  function signIn() {
    account.status = 'connected';
    account.address = OWNER;
    siwe.isSignedIn = true;
    siwe.sessionAddress = OWNER;
  }

  it('サインインしていなければ取りに行かず、既定の行 (作る・編集する) のまま', async () => {
    const fetchSpy = mockHandles({ ok: true, handles: [], max: 3 });
    account.status = 'connected';
    account.address = OWNER;
    renderStrip(page());
    expect(screen.getByRole('link', { name: '既定の行' })).toBeInTheDocument();
    await act(async () => {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('サインイン済みでも再接続の途中は取りに行かない (今つながっているときだけ)', async () => {
    const fetchSpy = mockHandles({ ok: true, handles: [], max: 3 });
    signIn();
    account.status = 'reconnecting';
    renderStrip(page());
    await act(async () => {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('サインイン済みなら最後に更新した @handle を、公開ページと同じテーマと色で出す', async () => {
    const fetchSpy = mockHandles({
      ok: true,
      max: 3,
      handles: [
        { handle: 'old_page', config: { to: OWNER, name: '古いページ', color: '#000000', methods: [] }, profile: { theme: 'bold' }, updatedAt: 1 },
        { handle: 'komorebi', config: { to: OWNER, name: 'こもれび', color: '#7c3aed', methods: [] }, profile: { theme: 'night' }, updatedAt: 2 },
      ],
    });
    signIn();
    renderStrip(page());
    const link = await screen.findByRole('link', { name: /こもれび/ });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/handle');
    expect(link).toHaveAttribute('href', '/ja/@komorebi');
    expect(link).toHaveTextContent('@komorebi');
    expect(screen.queryByText('古いページ')).toBeNull();
    // 名前 = inkColor・@handle = handleColor (components/HandleProfile.tsx と同じ割り当て)。
    const view = handleViewTheme('#7c3aed', 'night');
    expect(screen.getByText('こもれび').style.color).toBe('rgb(248, 250, 252)');
    expect(view.inkColor).toBe('#f8fafc');
    expect(screen.getByText('@komorebi')).toHaveStyle({ color: view.handleColor });
    expect(screen.getByRole('link', { name: ja.Landing.yourOpenPayPageEdit })).toHaveAttribute('href', '/ja/create?tab=profile');
    expect(screen.queryByRole('link', { name: '既定の行' })).toBeNull();
    expect(document.querySelector('[aria-label]')).toBeNull();
  });
  it('色とテーマは公開ページと同じ検証 (不正な色は既定の青・未知のテーマは clean)・名前がなければ「自分のページ」', async () => {
    mockHandles({ ok: true, max: 3, handles: [{ handle: 'plain', config: { to: OWNER, color: 'red', methods: [] }, profile: { theme: 'neon' } }] });
    signIn();
    renderStrip(page());
    const link = await screen.findByRole('link', { name: /@plain/ });
    expect(link).toHaveTextContent(ja.Landing.yourOpenPayPageTitle);
    expect(screen.getByText('@plain')).toHaveStyle({ color: handleViewTheme('#2563eb', 'clean').handleColor });
  });
  it('本人のアバター画像があれば出し、読めなければ頭文字に戻す', async () => {
    mockHandles({ ok: true, max: 3, handles: [{ handle: 'pic', config: { to: OWNER, name: 'Pic', methods: [] }, profile: { avatar: 'https://example.com/a.png' } }] });
    signIn();
    const { container } = renderStrip(page());
    await screen.findByRole('link', { name: /Pic/ });
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', 'https://example.com/a.png');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    await act(async () => {
      img.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('P')).toBeInTheDocument();
  });
  it('handle がない・取得に失敗したときは既定の行のまま (0 件と失敗を偽装しない = 既定の行に戻すだけ)', async () => {
    mockHandles({ ok: true, max: 3, handles: [] });
    signIn();
    const first = renderStrip(page());
    await act(async () => {});
    expect(screen.getByRole('link', { name: '既定の行' })).toBeInTheDocument();
    first.unmount();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockHandles({ ok: false, error: 'kv_error' }, 502);
    renderStrip(page());
    await act(async () => {});
    expect(screen.getByRole('link', { name: '既定の行' })).toBeInTheDocument();
  });
});
