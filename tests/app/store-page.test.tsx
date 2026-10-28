// /store (Store 一覧) を描画して検証する: 一覧の機械可読化 (ItemList は名前と商品ページの URL だけ)・
// JPYC をお持ちでない方への案内 (入手の節と ウォレットのガイド)・上部の小さな出品の入口・障害時は ItemList を出さない。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({
  enableCreatorStore: true,
  listings: [] as unknown[] | null,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, get enableCreatorStore() { return state.enableCreatorStore; } } };
});
vi.mock('@/lib/x402/storeListingCache', () => ({
  listStoreListingsCached: vi.fn(async () => state.listings),
}));
vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/components/StoreBrowser', () => ({
  StoreBrowser: () => <div data-testid="store-browser" />,
}));
vi.mock('next/link', () => ({
  default: ({ children, prefetch: _prefetch, ...props }: { children: ReactNode; prefetch?: boolean; href: string }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import StorePage from '@/app/[locale]/store/page';

function listing(id: string, title: string, handle = 'yamada') {
  return {
    id, title, handle, priceJpyc: '1000', totalJpyc: '1010', label: 'download', contentKind: 'url', updatedAt: 1,
    details: '詳しい説明', demoUrl: 'https://example.com/demo',
  };
}

async function renderStore(locale = 'ja', q?: string) {
  return render(await StorePage({
    params: Promise.resolve({ locale }),
    ...(q === undefined ? {} : { searchParams: Promise.resolve({ q }) }),
  }));
}

function jsonLd(container: HTMLElement) {
  return [...container.querySelectorAll('script[type="application/ld+json"]')].map(
    (node) => JSON.parse(node.textContent ?? '') as Record<string, unknown>,
  );
}

describe('/store', () => {
  beforeEach(() => {
    state.enableCreatorStore = true;
    state.listings = [];
  });

  it('ItemList は一覧と同じ順に名前と商品ページの URL だけを並べる (価格や詳細は商品ページの Product に一本化)', async () => {
    state.listings = [listing(`h_${'a'.repeat(32)}`, 'ローポリ カフェ'), listing(`h_${'b'.repeat(32)}`, 'ジングル素材', 'sound')];
    const { container } = await renderStore();
    const [itemList] = jsonLd(container);
    expect(itemList).toEqual({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'metaTitle',
      numberOfItems: 2,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'ローポリ カフェ', url: `https://open-pay.jp/ja/@yamada?product=h_${'a'.repeat(32)}` },
        { '@type': 'ListItem', position: 2, name: 'ジングル素材', url: `https://open-pay.jp/ja/@sound?product=h_${'b'.repeat(32)}` },
      ],
    });
    expect(JSON.stringify(itemList)).not.toContain('1010');
    expect(JSON.stringify(itemList)).not.toContain('詳しい説明');
  });

  it('?q= で絞り込んだ表示 (canonical は /store) には ItemList を出さない (画面に出ていない商品を並べない)', async () => {
    state.listings = [listing(`h_${'a'.repeat(32)}`, 'ローポリ カフェ'), listing(`h_${'b'.repeat(32)}`, 'ジングル素材', 'sound')];
    expect(jsonLd((await renderStore('ja', '@sound')).container)).toEqual([]);
    expect(jsonLd((await renderStore('ja', '')).container)).toHaveLength(1);
  });

  it('商品ゼロと保存先の障害では ItemList を出さない', async () => {
    expect(jsonLd((await renderStore()).container)).toEqual([]);
    state.listings = null;
    const { container } = await renderStore();
    expect(jsonLd(container)).toEqual([]);
    expect(screen.getByText('storageError')).toBeInTheDocument();
  });

  it('JPYC をお持ちでない方へ: 入手の節 (/guide/pay#get-jpyc) とウォレットのガイドへ案内する・上部に小さな出品の入口', async () => {
    await renderStore();
    expect(screen.getByText('noJpycLabel')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'noJpycGetLink' })).toHaveAttribute('href', '/ja/guide/pay#get-jpyc');
    expect(screen.getByRole('link', { name: 'noJpycWalletLink' })).toHaveAttribute('href', '/ja/guide/wallet');
    // スマホは短い「出品ガイド」・sm 以上は問いかけの一文 (同じリンク・CSS で出し分け)。
    // jsdom は CSS を当てないので名前は両方を含む (下の大きな CTA の「出品ガイド」とは別のリンク)。
    const sell = screen.getByRole('link', { name: /sellCtaTitle/ });
    expect(sell).toHaveAttribute('href', '/ja/guide/store');
    expect(sell.querySelector('.sm\\:hidden')).toHaveTextContent('sellCtaGuide');
    expect(sell.querySelector('.hidden.sm\\:inline')).toHaveTextContent('sellCtaTitle');
  });

  it('flag OFF は notFound', async () => {
    state.enableCreatorStore = false;
    await expect(StorePage({ params: Promise.resolve({ locale: 'ja' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
