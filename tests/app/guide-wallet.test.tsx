// /guide/wallet「ウォレットを選ぶ」を実描画で検証する: h1 (目次の名前)・節の見出しの順・ウォレット 3 つ・
// QR の読み取り方 2 つと注意 (ウォレットのアプリでは開かないものがある)・WalletConnect の 4 手順 (お客様の番号 = blue)・
// リンク先 (/scan・関連ガイド)・目次の現在地・aria-label を使わないこと (掟 8)。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import GuideWalletPage from '@/app/[locale]/guide/wallet/page';
import { guideNavFor } from '@/lib/guideNav';
import { walletGuideContentFor } from '@/lib/walletGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide/wallet', () => {
  it.each(['ja', 'en'] as const)('%s: 頭・節・ウォレット・読み取り方・つなぎ方・リンク', async (locale) => {
    const c = walletGuideContentFor(locale);
    const nav = guideNavFor(locale);
    const { container } = render(await GuideWalletPage({ params: Promise.resolve({ locale }) }));
    const article = container.querySelector('article')!;

    expect(screen.getByRole('heading', { level: 1, name: nav.items.wallet.label })).toBeInTheDocument();
    expect(screen.getByText(c.subtitle)).toBeInTheDocument();
    expect(screen.getByText(c.lead)).toBeInTheDocument();
    expect(within(article).getByRole('link', { name: c.scanCta.label })).toHaveAttribute('href', `/${locale}/scan`);

    expect(within(article).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      c.walletsTitle,
      c.scanTitle,
      c.wcTitle,
      c.relatedTitle,
    ]);

    const wallets = screen.getByRole('heading', { level: 2, name: c.walletsTitle }).closest('section')!;
    for (const w of c.wallets) {
      expect(within(wallets).getByText(w.name)).toBeInTheDocument();
      expect(within(wallets).getByText(w.body)).toBeInTheDocument();
    }

    const scan = screen.getByRole('heading', { level: 2, name: c.scanTitle }).closest('section')!;
    for (const way of c.scanWays) expect(within(scan).getByText(way.body)).toBeInTheDocument();
    expect(within(scan).getByText(c.scanNote)).toBeInTheDocument();

    const wc = screen.getByRole('heading', { level: 2, name: c.wcTitle }).closest('section')!;
    const badges = within(wc).getAllByRole('listitem').map((li) => li.querySelector('span')!);
    expect(badges.map((b) => b.textContent)).toEqual(['1', '2', '3', '4']);
    for (const badge of badges) expect(badge.className).toContain('bg-blue-600');
    expect(within(wc).getByText(c.wcTip)).toBeInTheDocument();

    for (const link of c.related) {
      expect(within(article).getByRole('link', { name: `${link.label} →` })).toHaveAttribute('href', `/${locale}${link.path}`);
    }

    // 目次の現在地はこのページ (PC・スマホの 2 つの nav で 1 個ずつ)。
    const current = container.querySelectorAll('nav a[aria-current="page"]');
    expect([...current].map((a) => a.getAttribute('href'))).toEqual([`/${locale}/guide/wallet`, `/${locale}/guide/wallet`]);
    expect(article.querySelectorAll('[aria-label]')).toHaveLength(0);
  });
});
