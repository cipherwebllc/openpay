import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { act, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import ja from '../../messages/ja.json';
import { renderWithIntl } from '../_helpers/i18n';
import { localDateKey, TODAY_SUMMARY_KEY } from '@/lib/history';

// wagmi の接続状態を test ごとに切り替える。
const account = vi.hoisted(() => ({ address: undefined as string | undefined, status: 'disconnected' as string }));
vi.mock('wagmi', () => ({ useAccount: () => account }));
const flags = vi.hoisted(() => ({ enableHandles: true, enableOrderRelay: true, enableShopLive: false, enableMobileOrder: true }));
vi.mock('@/lib/env', () => ({ env: flags }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async () => createTranslator({ locale: 'ja', messages: ja, namespace: 'Landing' }),
}));

import { LandingYourOpenPay } from '@/components/LandingYourOpenPay';
import { YourOpenPayFrame } from '@/components/LandingYourOpenPayClient';
import { RETURNING_WALLET_PREPAINT, WAGMI_STORE_KEY } from '@/hooks/useReturningWallet';

const SHOP = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const GLOBAL = '__openpayReturningWallet';
const win = window as unknown as Record<string, unknown>;

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
  window.localStorage.clear();
  delete win[GLOBAL];
  account.address = undefined;
  account.status = 'disconnected';
  Object.assign(flags, { enableHandles: true, enableOrderRelay: true, enableShopLive: false, enableMobileOrder: true });
});
afterEach(() => {
  document.body.innerHTML = '';
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

  it('アプリ内の移動で来たとき (静的 HTML でない) は、つながっているときだけ出す (前回の script の結果を持ち越さない)', () => {
    win[GLOBAL] = true; // 前のページ読み込みの結果が残っていても使わない
    renderWithIntl(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'no');
    expect(document.querySelector('script')).toBeNull();
  });
  it('このページでつないだら出る', () => {
    account.status = 'connected';
    account.address = SHOP;
    renderWithIntl(<YourOpenPayFrame>strip</YourOpenPayFrame>);
    expect(frame()).toHaveAttribute('data-returning', 'yes');
  });

  async function hydrate(returning: boolean) {
    const tree = (children: ReactNode) => (
      <NextIntlClientProvider locale="ja" messages={ja}>
        <YourOpenPayFrame>{children}</YourOpenPayFrame>
      </NextIntlClientProvider>
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree('strip'));
    document.body.appendChild(container);
    // server の HTML: 属性なし (未接続の見た目) + 描画前 script。script の働きを再現する。
    const el = container.querySelector('div') as HTMLElement;
    expect(el.hasAttribute('data-returning')).toBe(false);
    expect(container.querySelector('script')?.textContent).toBe(RETURNING_WALLET_PREPAINT);
    win[GLOBAL] = returning;
    if (returning) el.setAttribute('data-returning', 'yes');
    // RTL を通さない hydrateRoot なので、act を使える環境だと React に伝える。
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      hydrateRoot(container, tree('strip'));
    });
    return el;
  }

  it('静的 HTML から hydrate したときは描画前 script の結果を引き継ぐ (再接続に失敗しても消さない = 押し上げない)', async () => {
    account.status = 'disconnected';
    const el = await hydrate(true);
    expect(el).toHaveAttribute('data-returning', 'yes');
    // hydration が済んだら script は DOM から外す。
    expect(el.querySelector('script')).toBeNull();
  });
  it('目印のない訪問者は hydrate 後も出さない', async () => {
    const el = await hydrate(false);
    expect(el).toHaveAttribute('data-returning', 'no');
  });
});

describe('LandingYourOpenPay (中身)', () => {
  it('道具への近道は見えている名前で並び、未接続では今日の売上を出さない', async () => {
    renderWithIntl(await LandingYourOpenPay());
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
    storeToday(SHOP);
    expect(within(nav).queryByText(ja.Landing.yourOpenPayToday)).toBeNull();
  });
  it('つながっているときだけ、そのアドレスの今日の売上を見出しの行に出す', async () => {
    storeToday(SHOP);
    account.status = 'connected';
    account.address = SHOP;
    renderWithIntl(await LandingYourOpenPay());
    const pill = screen.getByText(ja.Landing.yourOpenPayToday).closest('a');
    expect(pill).toHaveAttribute('href', '/ja/history');
    expect(pill).toHaveTextContent('¥12,300');
    expect(pill).toHaveTextContent('8 件');
  });
  it('再接続の途中・別のアドレスでは売上を出さない', async () => {
    storeToday(SHOP);
    account.status = 'reconnecting';
    account.address = SHOP;
    const { unmount } = renderWithIntl(await LandingYourOpenPay());
    expect(screen.queryByText(ja.Landing.yourOpenPayToday)).toBeNull();
    unmount();
    account.status = 'connected';
    account.address = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
    renderWithIntl(await LandingYourOpenPay());
    expect(screen.queryByText(ja.Landing.yourOpenPayToday)).toBeNull();
  });
  it('flag で道具が決まる (注文の一覧がなければモバイルオーダーの設定・どちらもなければ 3 つ・handle OFF なら自分のページなし)', async () => {
    Object.assign(flags, { enableOrderRelay: false, enableShopLive: false, enableMobileOrder: true, enableHandles: false });
    const { unmount } = renderWithIntl(await LandingYourOpenPay());
    let links = within(screen.getByRole('region')).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/ja/create?tab=qr', '/ja/create?tab=register', '/ja/create?tab=mobileOrder', '/ja/history']);
    unmount();
    Object.assign(flags, { enableMobileOrder: false });
    renderWithIntl(await LandingYourOpenPay());
    links = within(screen.getByRole('region')).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/ja/create?tab=qr', '/ja/create?tab=register', '/ja/history']);
  });
});
