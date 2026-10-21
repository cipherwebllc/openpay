// /guide/sell の注意書きの URL リンク。文の途中の URL (Arc の売上を受け取るページ) で、後ろの文章までリンク先に
// 入って 404 になった (2026-10-21)。リンク先は URL ぴったりで、文章はリンクの外に残ること。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import GuideSellPage from '@/app/[locale]/guide/sell/page';
import { sellGuideContentFor } from '@/lib/sellGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide/sell の注意書きのリンク', () => {
  it.each(['ja', 'en'] as const)('%s: Arc の売上を受け取るページへのリンク先は URL ぴったり', async (locale) => {
    render(await GuideSellPage({ params: Promise.resolve({ locale }) }));
    const url = `https://open-pay.jp/${locale}/discovery/arc-payout`;
    const link = screen.getByRole('link', { name: url });
    expect(link).toHaveAttribute('href', url);
    // リンクの後ろの文章 (手数料の説明) はリンクの外に残る
    const paragraph = link.closest('p')!;
    expect(paragraph.textContent).toContain(locale === 'ja' ? 'Circle の手数料' : 'Circle’s fee');
    expect(link.textContent).toBe(url);
  });

  it.each(['ja', 'en'] as const)('%s: 注意書きの全リンクは空白やかっこを含まない', async (locale) => {
    render(await GuideSellPage({ params: Promise.resolve({ locale }) }));
    const hrefs = sellGuideContentFor(locale).bazaarNote.flatMap((note) => note.match(/https:\/\/[^\s()]+/g) ?? []);
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) {
      expect(screen.getByRole('link', { name: href })).toHaveAttribute('href', href);
    }
  });
});
