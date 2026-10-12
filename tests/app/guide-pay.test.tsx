// /guide/pay 「JPYC で支払う」を実描画で検証する: h1 (目次の名前)・副題・節の見出しの順・お客様の番号 (blue)・
// リンク先 (/scan・関連ガイド・料金・JPYC 公式は別タブ)・目次の現在地・aria-label を使わないこと (掟 8)・metadata。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import GuidePayPage, { generateMetadata } from '@/app/[locale]/guide/pay/page';
import { guideNavFor } from '@/lib/guideNav';
import { payGuideContentFor } from '@/lib/payGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide/pay', () => {
  it.each(['ja', 'en'] as const)('%s: 頭・節の見出し・手順・リンク', async (locale) => {
    const c = payGuideContentFor(locale);
    const nav = guideNavFor(locale);
    const { container } = render(await GuidePayPage({ params: Promise.resolve({ locale }) }));
    const article = container.querySelector('article')!;

    expect(screen.getByRole('heading', { level: 1, name: nav.items.pay.label })).toBeInTheDocument();
    expect(screen.getByText(c.subtitle)).toBeInTheDocument();
    expect(screen.getByText(c.lead)).toBeInTheDocument();

    // 本文の見出しの順 (このページの内容に載る節 → 関連ガイド → 末尾の行動ボタンの箱)。
    expect(within(article).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      c.needTitle,
      c.stepsTitle,
      c.signTitle,
      c.receiptTitle,
      c.jpycTitle,
      c.faqTitle,
      c.relatedTitle,
      c.ctaTitle,
    ]);
    // 関連ガイドと行動ボタンの箱は「このページの内容」に載せない。
    const skipped = [...article.querySelectorAll('h2[data-toc="skip"]')].map((h) => h.textContent);
    expect(skipped).toEqual([c.relatedTitle, c.ctaTitle]);

    // 手順は 6 つ・お客様の番号 (blue)。
    const steps = screen.getByRole('heading', { level: 2, name: c.stepsTitle }).closest('section')!;
    const badges = within(steps).getAllByRole('listitem').map((li) => li.querySelector('span')!);
    expect(badges.map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5', '6']);
    for (const badge of badges) expect(badge.className).toContain('bg-blue-600');
    for (const step of c.steps) {
      expect(within(steps).getByText(step.title)).toBeInTheDocument();
      expect(within(steps).getByText(step.body)).toBeInTheDocument();
    }
    for (const item of c.faq) {
      expect(screen.getByText(item.q)).toBeInTheDocument();
      expect(screen.getByText(item.a)).toBeInTheDocument();
    }

    // 「スキャンして支払う」は頭と末尾の 2 か所・どちらも /{locale}/scan。
    const scanLinks = within(article).getAllByRole('link', { name: c.scanCta.label });
    expect(scanLinks).toHaveLength(2);
    for (const link of scanLinks) expect(link).toHaveAttribute('href', `/${locale}/scan`);

    // 関連ガイドと料金。
    const related = screen.getByRole('heading', { level: 2, name: c.relatedTitle }).closest('section')!;
    expect(within(related).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      `/${locale}/guide/mobile-order`,
      `/${locale}/guide/agent`,
      `/${locale}/pricing`,
    ]);

    // JPYC 公式は別タブ (noopener)。
    const official = screen.getByRole('link', { name: `${c.jpycLink.label} →` });
    expect(official).toHaveAttribute('href', 'https://jpyc.co.jp/');
    expect(official).toHaveAttribute('target', '_blank');
    expect(official.getAttribute('rel')).toContain('noopener');

    // 目次の現在地はこのガイド (PC とスマホの 2 つの nav で 1 個ずつ)。
    const current = container.querySelectorAll('a[aria-current="page"]');
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toHaveAttribute('href', `/${locale}/guide/pay`);

    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });

  it('generateMetadata は canonical /{locale}/guide/pay と hreflang を返す', async () => {
    const m = await generateMetadata({ params: Promise.resolve({ locale: 'en' }) });
    expect(m.title).toBe(`${payGuideContentFor('en').metaTitle} · OpenPay`);
    expect(m.alternates?.canonical).toBe('/en/guide/pay');
    expect(m.alternates?.languages).toEqual({ ja: '/ja/guide/pay', en: '/en/guide/pay' });
  });
});
