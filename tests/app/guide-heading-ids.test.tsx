// 12 本のガイドの本文の見出し (h2) の id を実描画で検査する: 「このページの内容」に載る見出しは server で id を持ち
// (#id の深いリンクが JS なしで効く・plans/guide-ux-polish-2.md P4)、ページの中で重ならず、空白を含まない。

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { GUIDE_SLUGS, type GuideSlug } from '@/lib/guideNav';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

type Page = (props: { params: Promise<{ locale: string }> }) => Promise<React.ReactElement>;
const load = async (slug: GuideSlug): Promise<Page> => (await import(`@/app/[locale]/guide/${slug}/page`)).default as Page;

describe('ガイドの見出しの id', () => {
  const cases = GUIDE_SLUGS.flatMap((slug) => (['ja', 'en'] as const).map((locale) => [slug, locale] as const));
  it.each(cases)('%s (%s): 目次に載る h2 は id を持ち、重ならない', async (slug, locale) => {
    const Page = await load(slug);
    const { container } = render(await Page({ params: Promise.resolve({ locale }) }));
    const headings = [...container.querySelectorAll('article h2:not([data-toc="skip"])')];
    expect(headings.length).toBeGreaterThan(1);
    const ids = headings.map((h) => h.id);
    for (const id of ids) expect(id).toMatch(/^\S+$/);
    expect(new Set(ids).size).toBe(ids.length);
    const all = [...container.querySelectorAll('[id]')].map((e) => e.id);
    for (const id of ids) expect(all.filter((x) => x === id)).toHaveLength(1);
  });
});
