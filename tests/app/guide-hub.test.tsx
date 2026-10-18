// /guide ハブ (「OpenPay でできること」) を実描画で検証する: h1・5 グループの h2・
// 12 本の行 (href と、可視テキストから成るリンク名)・「補足」の中の料金 (/pricing)・
// aria-label を使わないこと (掟 8)・metadata。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import GuideHubPage, { generateMetadata } from '@/app/[locale]/guide/page';
import { GUIDE_SLUGS, guideNavFor } from '@/lib/guideNav';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide hub', () => {
  it.each(['ja', 'en'] as const)('%s: h1・リード・5 グループ・12 本の行 (重複なし)・補足の中の料金', async (locale) => {
    const nav = guideNavFor(locale);
    const { container } = render(await GuideHubPage({ params: Promise.resolve({ locale }) }));

    expect(screen.getByRole('heading', { level: 1, name: nav.hubTitle })).toBeInTheDocument();
    expect(screen.getByText(nav.hubLead)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: nav.backHome })).toHaveAttribute('href', `/${locale}`);
    // 5 グループだけ (料金は「補足」の中)。「はじめての方へ」は別の箱にせず、お店向けのパネルの頭の目印。
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(nav.groups.map((g) => g.title));
    const shops = screen.getByRole('heading', { level: 2, name: nav.groups[0].title }).closest('section')!;
    expect(within(shops).getByText(nav.hubStartTitle)).toBeInTheDocument();
    expect(within(shops).getByText(nav.hubStartLead)).toBeInTheDocument();
    // 読む順の番号はお店向けの 4 本 (ガイドの「次へ」と同じ順)。
    const steps = within(shops)
      .getAllByRole('link')
      .filter((a) => /^\d/.test(a.textContent ?? ''))
      .map((a) => [a.textContent?.[0], a.getAttribute('href')]);
    expect(steps).toEqual([
      ['1', `/${locale}/guide/start`],
      ['2', `/${locale}/guide/qr`],
      ['3', `/${locale}/guide/shop`],
      ['4', `/${locale}/guide/pos`],
    ]);

    // 同じガイドを二重に並べない (12 本が 1 回ずつ・目次の順)。
    const main = screen.getByRole('main');
    const cards = within(main)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith(`/${locale}/guide/`));
    expect(cards.map((a) => a.getAttribute('href'))).toEqual(
      GUIDE_SLUGS.map((slug) => `/${locale}/guide/${slug}`),
    );
    // リンク名 = タイトル + 説明 (どちらも可視テキスト)
    for (const group of nav.groups) {
      for (const [index, item] of group.items.entries()) {
        const step = group.id === 'shops' ? `${index + 1} ` : '';
        const card = screen.getByRole('link', { name: `${step}${item.label} ${item.summary}` });
        expect(card).toHaveAttribute('href', `/${locale}/guide/${item.slug}`);
      }
    }
    // 料金 (/{locale}/pricing) の行は「補足」の中 (画像 URL のガイドの後)。リンク名 = タイトル + 説明 (可視テキスト)。
    const pricing = nav.related.items.find((i) => i.id === 'pricing')!;
    const pricingCard = screen.getByRole('link', { name: `${pricing.label} ${pricing.summary}` });
    expect(pricingCard).toHaveAttribute('href', `/${locale}/pricing`);
    const more = nav.groups.find((g) => g.id === 'more')!;
    const moreSection = screen.getByRole('heading', { level: 2, name: more.title }).closest('section')!;
    expect(within(moreSection).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      `/${locale}/guide/image-url`,
      `/${locale}/pricing`,
    ]);
    // ハブには目次 (ガイド一覧の nav) を出さない
    expect(screen.queryByRole('navigation', { name: nav.navTitle })).toBeNull();
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });

  it('generateMetadata は canonical /{locale}/guide と hreflang を返す', async () => {
    const m = await generateMetadata({ params: Promise.resolve({ locale: 'en' }) });
    expect(m.title).toBe(guideNavFor('en').metaTitle);
    expect(m.alternates?.canonical).toBe('/en/guide');
    expect(m.alternates?.languages).toEqual({ ja: '/ja/guide', en: '/en/guide' });
  });
});
