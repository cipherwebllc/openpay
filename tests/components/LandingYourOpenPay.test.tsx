import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { act, useEffect, type ReactElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
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
import { LandingHero } from '@/components/LandingHero';
import { LANDING_SECTION_TITLE } from '@/components/LandingControls';
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
  // P5a: ヒーローを小さくするのは「開いたときに再訪」だけ。script は帯を出す属性と一緒に、開いたときの属性も付ける。
  it('再訪なら、帯を出す data-returning と一緒に、開いたときの印 data-returning-open も付ける', () => {
    const parent = document.createElement('div');
    window.localStorage.setItem(WAGMI_STORE_KEY, JSON.stringify({ state: { connections: { __type: 'Map', value: [] }, chainId: 137, current: 'uid-1' }, version: 2 }));
    runPrepaint(parent);
    expect(parent.getAttribute('data-returning-open')).toBe('yes');
    window.localStorage.clear();
    const fresh = document.createElement('div');
    runPrepaint(fresh);
    expect(fresh.hasAttribute('data-returning-open')).toBe(false);
  });
  // React は「script が走った読み込み」と「別のページから client の遷移で来た (script は走っていない)」を、window の結果の有無で
  // 見分ける。読めなかったときも false を残さないと、読めなかった読み込みを「走っていない」と取り違える。
  it('読めなかったとき (壊れた JSON・localStorage の例外) も、script が走った印として false を残す', () => {
    window.localStorage.setItem(WAGMI_STORE_KEY, '{not json');
    runPrepaint(document.createElement('div'));
    expect(win[GLOBAL]).toBe(false);
    delete win[GLOBAL];
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const parent = document.createElement('div');
    runPrepaint(parent);
    expect(win[GLOBAL]).toBe(false);
    expect(parent.hasAttribute('data-returning-open')).toBe(false);
    spy.mockRestore();
  });
});

describe('YourOpenPayFrame (枠を出すか)', () => {
  const frame = () => document.querySelector('[data-returning]');

  // server の HTML (属性なし + 描画前 script) を置き、script の働きを再現してから hydrate する。
  async function hydrate(
    returning: boolean,
    beforeHydrate?: (el: HTMLElement) => void,
  ): Promise<{ el: HTMLElement; root: Root; rerender: () => Promise<void> }> {
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
    expect(el.hasAttribute('data-returning-open')).toBe(false);
    expect(container.querySelector('script')?.textContent).toBe(RETURNING_WALLET_PREPAINT);
    win[GLOBAL] = returning;
    if (returning) {
      el.setAttribute('data-returning', 'yes');
      el.setAttribute('data-returning-open', 'yes');
    }
    beforeHydrate?.(el);
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

  // ---- P5a: 開いたときの判定 (data-returning-open = ヒーローを小さくする印)・client の遷移で来た帯 ----
  const open = () => frame()?.getAttribute('data-returning-open') ?? null;

  it('開いたときの再訪: script が付けた data-returning-open=yes を hydration の間も一度も消さず、その後も yes のまま', async () => {
    const records: MutationRecord[] = [];
    let observer!: MutationObserver;
    const { el, rerender } = await hydrate(true, (target) => {
      observer = new MutationObserver((list) => records.push(...list));
      observer.observe(target, { attributes: true, attributeOldValue: true, attributeFilter: ['data-returning-open'] });
    });
    records.push(...observer.takeRecords());
    observer.disconnect();
    expect(el).toHaveAttribute('data-returning-open', 'yes');
    // 属性が消えた (または no になった) 瞬間があれば、その次の変化の記録の oldValue が null / 'no' になる。
    expect(records.map((r) => r.oldValue).filter((v) => v !== 'yes')).toEqual([]);
    // 再接続の途中・失敗 (切断)・つなぎ直し・このページでの接続の操作のどれでも変えない (後から縮め直したり戻したりしない)。
    for (const status of ['connecting', 'reconnecting', 'disconnected', 'connected']) {
      account.status = status;
      await rerender();
      expect(el).toHaveAttribute('data-returning-open', 'yes');
    }
    await userConnects();
    await rerender();
    expect(el).toHaveAttribute('data-returning', 'yes');
    expect(el).toHaveAttribute('data-returning-open', 'yes');
  });
  it('このページで user がつないだときは帯を出すが、data-returning-open は no のまま (ヒーローを縮めない = 接続のときのずれを増やさない)', async () => {
    const { el, rerender } = await hydrate(false);
    expect(el).toHaveAttribute('data-returning-open', 'no');
    await userConnects();
    account.status = 'connected';
    account.address = SHOP;
    await rerender();
    expect(el).toHaveAttribute('data-returning', 'yes');
    expect(el).toHaveAttribute('data-returning-open', 'no');
  });
  it('hydration に失敗して帯を DOM ごと作り直しても (script の値は消える)、作り直した帯に React が data-returning-open=yes を付ける', async () => {
    // server と client で文字が違う兄弟を置き、hydration を失敗させる (React は root を client で描き直す)。
    let side = 'server';
    function Mismatch() {
      return <p>{side}</p>;
    }
    const tree = () => (
      <Providers>
        <Mismatch />
        <YourOpenPayFrame>strip</YourOpenPayFrame>
      </Providers>
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree());
    document.body.appendChild(container);
    const before = container.querySelector('script')!.parentElement as HTMLElement;
    win[GLOBAL] = true;
    before.setAttribute('data-returning', 'yes');
    before.setAttribute('data-returning-open', 'yes');
    side = 'client';
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const errors: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, tree(), { onRecoverableError: (error) => errors.push(error) });
    });
    // 本当に hydration に失敗して、帯を作り直したこと (このテストが空振りしない)。
    expect(errors.length).toBeGreaterThan(0);
    expect(before.isConnected).toBe(false);
    const after = frame() as HTMLElement;
    expect(after).not.toBe(before);
    expect(after).toHaveAttribute('data-returning', 'yes');
    expect(after).toHaveAttribute('data-returning-open', 'yes');
    expect(after.querySelector('script')).toBeNull();
  });
  it('別のページから client の遷移で初めて来た帯 (script は走っていない) は、mount の時点でつながっていれば出し、ヒーローも小さくする', () => {
    // script が走っていない = window に結果が無い (前の版は、この帯を「最初の帯」として結果なし = 再訪でないと判定していた)。
    expect(win[GLOBAL]).toBeUndefined();
    account.status = 'connected';
    account.address = SHOP;
    renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
    expect(open()).toBe('yes');
  });
  it('別のページから client の遷移で初めて来た帯は、mount の時点で未接続なら出さず、後の自動の再接続でも出さない', async () => {
    account.status = 'reconnecting';
    const { rerender } = renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'no');
    expect(open()).toBe('no');
    account.status = 'connected';
    account.address = SHOP;
    rerender(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'no');
    expect(open()).toBe('no');
  });
  it('接続 / 切断の後の往復: 開いたときの判定は、その帯を mount した時点の接続だけで決まり、読み込み時の script の結果を持ち越さない', async () => {
    // 1. 読み込み (script: 再訪) → このページで切断しても、開いたときに出した帯とヒーローは変えない (押し上げない)。
    const loaded = await hydrate(true);
    account.status = 'disconnected';
    await loaded.rerender();
    expect(loaded.el).toHaveAttribute('data-returning', 'yes');
    expect(loaded.el).toHaveAttribute('data-returning-open', 'yes');
    await act(async () => loaded.root.unmount());
    // 2. 切断したままほかのページから戻る → 出さない (読み込み時の script の結果 yes を使わない)。
    const back = renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'no');
    expect(open()).toBe('no');
    // 3. この帯の上でつなぐ → 帯は出すが、ヒーローは縮めない。
    await userConnects();
    account.status = 'connected';
    account.address = SHOP;
    back.rerender(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
    expect(open()).toBe('no');
    back.unmount();
    // 4. つないだままほかのページから戻る → 開いたときにつながっているので、帯もヒーローの縮みも最初から。
    renderStrip(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
    expect(open()).toBe('yes');
  });
  it('React 19 の StrictMode (効果が mount → unmount → mount) でも、script の結果を使った後に判定が変わらない', () => {
    win[GLOBAL] = true;
    const effects: string[] = [];
    function Probe() {
      useEffect(() => {
        effects.push('mount');
        return () => {
          effects.push('unmount');
        };
      }, []);
      return null;
    }
    const strict = render(
      <YourOpenPayFrame>
        <Probe />
        strip
      </YourOpenPayFrame>,
      { wrapper: Providers, reactStrictMode: true },
    );
    // StrictMode の二重の mount が本当に起きた (このテストが空振りしない)。
    expect(effects).toEqual(['mount', 'unmount', 'mount']);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
    expect(open()).toBe('yes');
    // 使った結果は消す (アプリ内の移動で戻ってきた帯に持ち越さない)。
    expect(win[GLOBAL]).toBeUndefined();
    strict.unmount();
    render(<YourOpenPayFrame>strip</YourOpenPayFrame>, { wrapper: Providers, reactStrictMode: true });
    expect(frame()).toHaveAttribute('data-returning', 'no');
    expect(open()).toBe('no');
  });
});

// ヒーローは帯の外枠 (直前の兄弟) の属性を `[属性]+section` の CSS で見る (最初の描画から決まる = 後から動かない)。
// jsdom は Tailwind の CSS を当てないので、どの要素がどの属性の指定を持つかを class で固定する (実ブラウザは e2e/landing.spec.ts)。
describe('ヒーロー (開いたときの再訪で小さくする・P5a)', () => {
  const OPEN = '[[data-returning-open=yes]+section_&]';
  const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  /** el から節までのどこかに、指定の属性で隠す class があるか。 */
  const hiddenBy = (el: Element, root: Element, variant: string) => {
    for (let n: Element | null = el; n && n !== root; n = n.parentElement) if (tokens(n).includes(`${variant}:hidden`)) return true;
    return false;
  };

  async function renderHero() {
    const root = render(await LandingHero()).container.querySelector('section') as HTMLElement;
    return {
      root,
      pill: within(root).getByText(ja.Landing.tagline),
      h2: within(root).getByRole('heading', { level: 2, name: ja.Landing.heroLeadline }),
      body: within(root).getByText(ja.Landing.heroBody),
      cta: within(root).getByRole('link', { name: ja.Landing.heroCta }),
      nav: within(root).getByRole('navigation', { name: ja.Landing.heroAudienceLead }),
    };
  }

  it('開いたときの再訪だけで、タグラインのピルと主ボタンを隠す。見出し・本文 (利用料の開示)・お店以外の方の入口は隠さない', async () => {
    const { root, pill, h2, body, cta, nav } = await renderHero();
    expect(hiddenBy(pill, root, OPEN)).toBe(true);
    expect(hiddenBy(cta, root, OPEN)).toBe(true);
    for (const el of [h2, body, nav, ...within(nav).getAllByRole('link')]) expect(hiddenBy(el, root, OPEN)).toBe(false);
    // このページでつないだとき (data-returning だけ yes) は、ピルも主ボタンも隠さない (縮めるのは開いたときの判定だけ)。
    for (const el of [pill, cta, h2, body, nav]) expect(hiddenBy(el, root, '[[data-returning=yes]+section_&]')).toBe(false);
    // 主ボタンの class は変えない (隠すのは外側の行)。
    expect(tokens(cta).filter((token) => token.includes('data-returning'))).toEqual([]);
  });

  it('開いたときの再訪の見出しは、節の見出し (md) と同じ大きさ。PC は見出し・本文・入口の行を中央に寄せる', async () => {
    const { h2, body, nav } = await renderHero();
    // LANDING_SECTION_TITLE.md の各指定に、開いたときの属性を足したもの (sm: などの幅の指定は外側に置く)。
    const expected = LANDING_SECTION_TITLE.md.split(/\s+/).map((token) => {
      const m = token.match(/^((?:sm|md|lg|xl):)?(.+)$/)!;
      return `${m[1] ?? ''}${OPEN}:${m[2]}`;
    });
    expect(tokens(h2).filter((token) => token.includes('data-returning') && token.includes(':text-'))).toEqual(expected);
    // 中央寄せ: 文字の行 (見出しと本文の外側の塊)・本文の左右の余白・入口の行。
    expect(tokens(h2.parentElement!)).toContain(`lg:${OPEN}:text-center`);
    expect(tokens(body)).toContain(`lg:${OPEN}:mx-auto`);
    expect(tokens(nav.querySelector('ul')!)).toContain(`lg:${OPEN}:justify-center`);
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
    <YourOpenPayPage
      fallback={<a href="#default-row">既定の行</a>}
      pageLabel={ja.Landing.yourOpenPayPageTitle}
      editLabel={ja.Landing.yourOpenPayPageEdit}
      copyLabel={ja.Landing.yourOpenPayPageCopy}
      copiedLabel={ja.Landing.yourOpenPayPageCopied}
    />
  );
  function mockHandles(body: unknown, status = 200) {
    const spy = vi.spyOn(globalThis, 'fetch');
    // vitest 4 以降の spyOn は spy 済みの fetch に同じ spy (呼び出しの履歴つき) を返すので、毎回の spy を空から数える。
    spy.mockClear();
    return spy.mockResolvedValue(new Response(JSON.stringify(body), { status }));
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
    expect(screen.getByText('こもれび')).toHaveStyle({ color: view.inkColor });
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
  it('別の wallet でつないでいる間は、前にサインインした wallet の cache があっても出さず、取りにも行かない', async () => {
    const fetchSpy = mockHandles({ ok: true, handles: [], max: 3 });
    // セッション (OWNER) の cache は残っている (前に /create で読んだ)。
    queryClient.setQueryData(['handle-mine', OWNER], {
      max: 3,
      handles: [{ handle: 'owner_page', config: { to: OWNER, name: '持ち主', methods: [] }, updatedAt: 1 }],
    });
    account.status = 'connected';
    account.address = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
    siwe.isSignedIn = false; // 接続中のアドレス ≠ セッションのアドレス
    siwe.sessionAddress = OWNER;
    renderStrip(page());
    await act(async () => {});
    expect(screen.queryByText('持ち主')).toBeNull();
    expect(screen.getByRole('link', { name: '既定の行' })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('開き直しても 5 分以内は取り直さず、編集画面の保存 (invalidate) の後は取り直す', async () => {
    const fetchSpy = mockHandles({ ok: true, max: 3, handles: [{ handle: 'komorebi', config: { to: OWNER, name: 'こもれび', methods: [] } }] });
    signIn();
    const first = renderStrip(page());
    await screen.findByRole('link', { name: /こもれび/ });
    first.unmount();
    renderStrip(page());
    await screen.findByRole('link', { name: /こもれび/ });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true, max: 3, handles: [] }), { status: 200 }));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['handle-mine'] });
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('link', { name: '既定の行' })).toBeInTheDocument();
  });
  it('handle がない・取得に失敗したときは既定の行のまま (0 件と失敗を偽装しない = 既定の行に戻すだけ)', async () => {
    const empty = mockHandles({ ok: true, max: 3, handles: [] });
    signIn();
    const first = renderStrip(page());
    await act(async () => {});
    expect(screen.getByRole('link', { name: '既定の行' })).toBeInTheDocument();
    expect(empty).toHaveBeenCalledTimes(1);
    first.unmount();
    queryClient = new QueryClient();
    const failing = mockHandles({ ok: false, error: 'kv_error' }, 502);
    renderStrip(page());
    await act(async () => {});
    expect(screen.getByRole('link', { name: '既定の行' })).toBeInTheDocument();
    // 飾りのカードなので失敗しても取り直さない (KV を叩き直さない)。既定の再試行は 1 秒後からなので、設定そのものを見る。
    expect(failing).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().find({ queryKey: ['handle-mine', OWNER] })?.options.retry).toBe(false);
  });
});

// P5b (plans/lp-polish-2026-11.md): 自分のページのカードの「編集」の隣に、公開ページの URL のコピー。文言は user が 11/16 に承認。
describe('YourOpenPayPage: 自分のページの URL のコピー (P5b)', () => {
  const OWNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
  const L = ja.Landing;
  const page = () => (
    <YourOpenPayPage
      fallback={<a href="#default-row">既定の行</a>}
      pageLabel={L.yourOpenPayPageTitle}
      editLabel={L.yourOpenPayPageEdit}
      copyLabel={L.yourOpenPayPageCopy}
      copiedLabel={L.yourOpenPayPageCopied}
    />
  );
  const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const icon = (button: HTMLElement) => button.querySelector('svg')?.getAttribute('class') ?? '';
  const status = () => document.querySelector('[role="status"]');
  let clipboardDesc: PropertyDescriptor | undefined;
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

  function handles(list: unknown[]) {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockClear();
    return spy.mockResolvedValue(new Response(JSON.stringify({ ok: true, max: 3, handles: list }), { status: 200 }));
  }
  const komorebi = (theme = 'gradient') => ({ handle: 'komorebi', config: { to: OWNER, name: 'こもれび', color: '#0d9488', methods: [] }, profile: { theme }, updatedAt: 1 });
  function signIn() {
    account.status = 'connected';
    account.address = OWNER;
    siwe.isSignedIn = true;
    siwe.sessionAddress = OWNER;
  }
  async function click(button: HTMLElement) {
    await act(async () => {
      fireEvent.click(button);
      // clipboard の Promise を待つ (fake timers の間も進む microtask だけで待つ)。
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  }

  beforeEach(() => {
    clipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (clipboardDesc) Object.defineProperty(navigator, 'clipboard', clipboardDesc);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  it('承認済みの文言: ボタンは「コピー」/「Copy」・押した後の読み上げは「コピーしました」/「Copied」(Landing の namespace)', () => {
    expect([ja.Landing.yourOpenPayPageCopy, ja.Landing.yourOpenPayPageCopied]).toEqual(['コピー', 'コピーしました']);
    expect([en.Landing.yourOpenPayPageCopy, en.Landing.yourOpenPayPageCopied]).toEqual(['Copy', 'Copied']);
  });

  it('サインイン済みで @handle があるときだけ出す。未サインイン・handle なしは既定の行のまま', async () => {
    handles([komorebi()]);
    account.status = 'connected';
    account.address = OWNER;
    const anon = renderStrip(page());
    await act(async () => {});
    expect(screen.queryByRole('button')).toBeNull();
    anon.unmount();
    signIn();
    handles([]);
    queryClient = new QueryClient();
    const none = renderStrip(page());
    await act(async () => {});
    expect(screen.getByRole('link', { name: '既定の行' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    none.unmount();
    handles([komorebi()]);
    queryClient = new QueryClient();
    renderStrip(page());
    // 名前は見えている「コピー」そのもの (aria-label で置き換えない・掟 8)。
    const button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    expect(button).toHaveTextContent(L.yourOpenPayPageCopy);
    expect(button).not.toHaveAttribute('aria-label');
    expect(document.querySelector('[aria-label]')).toBeNull();
  });

  it('押すと、今の origin + /@handle (locale なし) をコピーし、見えない status で「コピーしました」と読ませる。見える文字は「コピー」のまま印だけ変え、1.5 秒で戻す', async () => {
    handles([komorebi()]);
    signIn();
    renderStrip(page());
    const button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    expect(icon(button)).toContain('lucide-copy');
    expect(status()).toHaveTextContent('');
    vi.useFakeTimers();
    await click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/@komorebi`);
    expect(status()).toHaveTextContent(L.yourOpenPayPageCopied);
    expect(status()).toHaveClass('sr-only');
    expect(button).toHaveTextContent(L.yourOpenPayPageCopy);
    expect(button).toHaveAccessibleName(L.yourOpenPayPageCopy);
    expect(icon(button)).toContain('lucide-check');
    // 印は字と同じ大きさのまま (幅を変えない)。
    expect(tokens(button.querySelector('svg')!)).toEqual(expect.arrayContaining(['h-3.5', 'w-3.5']));
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(status()).toHaveTextContent('');
    expect(icon(button)).toContain('lucide-copy');
  });

  it('コピーに失敗したとき (権限の拒否など) は、status も印も出さず、カードはそのまま', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    handles([komorebi()]);
    signIn();
    renderStrip(page());
    const button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    await click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(status()).toHaveTextContent('');
    expect(icon(button)).toContain('lucide-copy');
    expect(screen.getByRole('link', { name: /こもれび/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: L.yourOpenPayPageEdit })).toBeInTheDocument();
  });

  it('clipboard の無い環境では、押しても何も起きないボタンを出さない (カードと編集はそのまま)', async () => {
    delete (navigator as unknown as Record<string, unknown>).clipboard;
    handles([komorebi()]);
    signIn();
    renderStrip(page());
    await screen.findByRole('link', { name: /こもれび/ });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: L.yourOpenPayPageEdit })).toBeInTheDocument();
  });

  it('公開ページへのリンクの外の独立したボタン。行の順は 名前のリンク → コピー → 編集', async () => {
    handles([komorebi()]);
    signIn();
    renderStrip(page());
    const button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    expect(button.closest('a')).toBeNull();
    const pageLink = screen.getByRole('link', { name: /こもれび/ });
    expect(pageLink).toHaveAttribute('href', '/ja/@komorebi');
    expect(pageLink.contains(button)).toBe(false);
    const row = pageLink.parentElement!;
    const controls = [...row.querySelectorAll(':scope > a, :scope > button')];
    expect(controls.map((el) => el.textContent)).toEqual([expect.stringContaining('こもれび'), L.yourOpenPayPageCopy, L.yourOpenPayPageEdit]);
    // 読み上げの欄もカードの中 (行の高さを取らない sr-only)。
    expect(row.contains(status())).toBe(true);
  });

  it('形は「編集」と同じ型 (大きさ・角・字・地の色)。focus の輪は 2px・外側 2px で、暗いテーマ (night) は白・地も「編集」と同じ出し分け', async () => {
    handles([komorebi('gradient')]);
    signIn();
    const light = renderStrip(page());
    let button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    let edit = screen.getByRole('link', { name: L.yourOpenPayPageEdit });
    expect(tokens(button)).toEqual(expect.arrayContaining(tokens(edit)));
    expect(tokens(button)).toEqual(expect.arrayContaining(['focus-visible:outline', 'focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-brand']));
    expect(tokens(button)).toContain('bg-white/90');
    light.unmount();
    handles([komorebi('night')]);
    queryClient = new QueryClient();
    renderStrip(page());
    button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    edit = screen.getByRole('link', { name: L.yourOpenPayPageEdit });
    expect(tokens(button)).toEqual(expect.arrayContaining(tokens(edit)));
    expect(tokens(button)).toContain('bg-white/15');
    expect(tokens(button)).toContain('focus-visible:outline-white');
    expect(tokens(button)).not.toContain('focus-visible:outline-brand');
  });

  it('「編集」にも「コピー」と同じ focus の輪 (2px・外側 2px・明るい地は紺・night は白)。何もしないときの形と地の色は今のまま', async () => {
    const RING = ['focus-visible:outline', 'focus-visible:outline-2', 'focus-visible:outline-offset-2'];
    // 太さ (数字) と外側の指定を除いた focus-visible:outline-* が、色の指定 (ちょうど 1 つ)。
    const ringColors = (el: Element) => tokens(el).filter((token) => /^focus-visible:outline-(?!\d|offset-)/.test(token));
    handles([komorebi('gradient')]);
    signIn();
    const light = renderStrip(page());
    let edit = await screen.findByRole('link', { name: L.yourOpenPayPageEdit });
    expect(tokens(edit)).toEqual(expect.arrayContaining([...RING, 'bg-white/90', 'text-slate-700', 'ring-1', 'ring-slate-200', 'rounded-full', 'py-1.5']));
    expect(ringColors(edit)).toEqual(['focus-visible:outline-brand']);
    light.unmount();
    handles([komorebi('night')]);
    queryClient = new QueryClient();
    renderStrip(page());
    edit = await screen.findByRole('link', { name: L.yourOpenPayPageEdit });
    expect(tokens(edit)).toEqual(expect.arrayContaining([...RING, 'bg-white/15', 'text-white']));
    expect(ringColors(edit)).toEqual(['focus-visible:outline-white']);
    expect(ringColors(screen.getByRole('button', { name: L.yourOpenPayPageCopy }))).toEqual(['focus-visible:outline-white']);
  });

  it('360px 未満だけ行の中を詰めて名前の欄を広げる (アバター・間・ボタンの左右の余白)。ボタンの高さ・見える文字・印は変えない', async () => {
    handles([komorebi()]);
    signIn();
    renderStrip(page());
    const button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    const edit = screen.getByRole('link', { name: L.yourOpenPayPageEdit });
    const pageLink = screen.getByRole('link', { name: /こもれび/ });
    const card = pageLink.parentElement!;
    const avatar = pageLink.firstElementChild!;
    const narrow = (el: Element) => tokens(el).filter((token) => token.startsWith('max-[359px]:'));
    expect(narrow(card)).toEqual(['max-[359px]:gap-1.5', 'max-[359px]:pl-2.5']);
    expect(narrow(pageLink)).toEqual(['max-[359px]:gap-2']);
    expect(narrow(avatar)).toEqual(['max-[359px]:h-8', 'max-[359px]:w-8']);
    expect(narrow(button)).toEqual(['max-[359px]:px-2']);
    expect(narrow(edit)).toEqual(['max-[359px]:px-2']);
    // 文字・印・読み上げの欄には狭い画面だけの指定を付けない (隠さない・小さくしない)。
    for (const el of [button.querySelector('svg')!, ...[...card.querySelectorAll('span')].filter((span) => span !== avatar)]) expect(narrow(el)).toEqual([]);
    // 360px 以上の指定は今のまま (カードの高さ 56px・ボタンの高さ 28px)。
    expect(tokens(card)).toEqual(expect.arrayContaining(['h-14', 'gap-3', 'pl-3.5', 'pr-2']));
    for (const el of [button, edit]) expect(tokens(el)).toEqual(expect.arrayContaining(['px-3', 'py-1.5', 'text-xs']));
  });

  it('server の帯 (LandingYourOpenPay) が Landing の文言をボタンと読み上げに渡す', async () => {
    handles([komorebi()]);
    signIn();
    renderStrip(await LandingYourOpenPay());
    const button = await screen.findByRole('button', { name: L.yourOpenPayPageCopy });
    await click(button);
    expect(status()).toHaveTextContent(L.yourOpenPayPageCopied);
  });
});
