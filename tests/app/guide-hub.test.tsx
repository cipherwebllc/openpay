// /guide ハブ (「OpenPay でできること」) を実描画で検証する: h1・5 グループの h2・
// 10 本のカード (href と、可視テキストから成るリンク名)・末尾の「関連ページ」(料金 /pricing)・
// aria-label を使わないこと (掟 8)・metadata。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import GuideHubPage, { generateMetadata } from '@/app/[locale]/guide/page';
import { GUIDE_SLUGS, guideNavFor } from '@/lib/guideNav';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide hub', () => {
  it.each(['ja', 'en'] as const)('%s: h1・リード・5 グループ・10 本のカード・末尾の関連ページ', async (locale) => {
    const nav = guideNavFor(locale);
    const { container } = render(await GuideHubPage({ params: Promise.resolve({ locale }) }));

    expect(screen.getByRole('heading', { level: 1, name: nav.hubTitle })).toBeInTheDocument();
    expect(screen.getByText(nav.hubLead)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: nav.backHome })).toHaveAttribute('href', `/${locale}`);
    // 5 グループの後ろ (末尾) に「関連ページ」。
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      ...nav.groups.map((g) => g.title),
      nav.related.title,
    ]);

    const main = screen.getByRole('main');
    const cards = within(main)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.startsWith(`/${locale}/guide/`));
    expect(cards.map((a) => a.getAttribute('href'))).toEqual(
      GUIDE_SLUGS.map((slug) => `/${locale}/guide/${slug}`),
    );
    // リンク名 = タイトル + 説明 (どちらも可視テキスト)
    for (const group of nav.groups) {
      for (const item of group.items) {
        const card = screen.getByRole('link', { name: `${item.label} ${item.summary}` });
        expect(card).toHaveAttribute('href', `/${locale}/guide/${item.slug}`);
      }
    }
    // 関連ページ: 料金 (/{locale}/pricing) のカード 1 枚。リンク名 = タイトル + 説明 (可視テキスト)。
    const pricing = nav.related.items.find((i) => i.id === 'pricing')!;
    const pricingCard = screen.getByRole('link', { name: `${pricing.label} ${pricing.summary}` });
    expect(pricingCard).toHaveAttribute('href', `/${locale}/pricing`);
    const relatedSection = screen.getByRole('heading', { level: 2, name: nav.related.title }).closest('section')!;
    expect(within(relatedSection).getAllByRole('link')).toEqual([pricingCard]);
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
