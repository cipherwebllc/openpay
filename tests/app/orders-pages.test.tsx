// 厨房/ホール ルートページ (app/[locale]/orders/{kitchen,hall}/page.tsx) の **inert 境界**を検証。
// 本番安全性の核心: 両フラグ (enableOrderFulfillment かつ enableOrderRelay) が無いと notFound()
// = ページ自体が存在しない。無効 locale も notFound。両 ON + 有効 locale でのみ board を描画。
// 実 page 関数 (async server component) を直接呼び、env / next-intl/server / next/navigation を mock。
// notFound は本物同様 throw する sentinel にし、ゲート発火を「呼出が reject する」ことで実証。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const flags = vi.hoisted(() => ({ enableOrderFulfillment: true, enableOrderRelay: true }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableOrderFulfillment() {
        return flags.enableOrderFulfillment;
      },
      get enableOrderRelay() {
        return flags.enableOrderRelay;
      },
    },
  };
});

// notFound() は Next では NEXT_NOT_FOUND を throw して描画を中断する。同じ「中断」を sentinel で再現。
const notFoundSpy = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('next/navigation', () => ({ notFound: notFoundSpy }));

// server-only API は jsdom で動かないため mock (挙動: t(key)=key・setRequestLocale は no-op)。
const setRequestLocaleSpy = vi.hoisted(() => vi.fn());
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string) => k,
  setRequestLocale: setRequestLocaleSpy,
}));

// board / 周辺 UI は別テストで担保済み → ここでは描画されたか + mode だけ確認する stub。
vi.mock('@/components/OrderFulfillmentBoard', () => ({
  OrderFulfillmentBoard: ({ mode }: { mode: string }) => <div data-testid="board">{mode}</div>,
}));
vi.mock('@/components/LocaleSwitcher', () => ({ LocaleSwitcher: () => <div data-testid="locale-switcher" /> }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import KitchenPage from '@/app/[locale]/orders/kitchen/page';
import HallPage from '@/app/[locale]/orders/hall/page';

const PAGES = [
  { name: 'kitchen', Page: KitchenPage, mode: 'kitchen' },
  { name: 'hall', Page: HallPage, mode: 'hall' },
] as const;

beforeEach(() => {
  flags.enableOrderFulfillment = true;
  flags.enableOrderRelay = true;
  notFoundSpy.mockClear();
  setRequestLocaleSpy.mockClear();
});

describe.each(PAGES)('orders/$name page (inert 境界)', ({ Page, mode }) => {
  it('両フラグ ON + 有効 locale → board を mode 付きで描画', async () => {
    const ui = await Page({ params: Promise.resolve({ locale: 'ja' }) });
    render(ui);
    expect(screen.getByTestId('board')).toHaveTextContent(mode);
    expect(notFoundSpy).not.toHaveBeenCalled();
    expect(setRequestLocaleSpy).toHaveBeenCalledWith('ja');
  });

  it('enableOrderFulfillment OFF → notFound (ページ非存在)', async () => {
    flags.enableOrderFulfillment = false;
    await expect(Page({ params: Promise.resolve({ locale: 'ja' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalled();
  });

  it('enableOrderRelay OFF → notFound (受注リレー無しでは存在しない)', async () => {
    flags.enableOrderRelay = false;
    await expect(Page({ params: Promise.resolve({ locale: 'ja' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalled();
  });

  it('両フラグ OFF (本番既定) → notFound', async () => {
    flags.enableOrderFulfillment = false;
    flags.enableOrderRelay = false;
    await expect(Page({ params: Promise.resolve({ locale: 'ja' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalled();
  });

  it('無効 locale → notFound (フラグ判定より前にロケール検証)', async () => {
    await expect(Page({ params: Promise.resolve({ locale: 'xx' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalled();
    expect(setRequestLocaleSpy).not.toHaveBeenCalled(); // locale 不正なら setRequestLocale まで進まない
  });
});
