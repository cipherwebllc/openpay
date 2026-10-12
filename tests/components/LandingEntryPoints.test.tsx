// トップ「はじめ方」のガイドへの入口 (4 枚) と、その下の全ガイドのハブ (/guide) へのリンク。
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
import { guideNavFor } from '@/lib/guideNav';
import { LandingEntryPoints } from '@/components/LandingEntryPoints';

const localeState = vi.hoisted(() => ({ value: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => localeState.value,
  getTranslations: async () =>
    createTranslator({ locale: localeState.value, messages: localeState.value === 'en' ? en : ja, namespace: 'Landing' }),
}));

describe('LandingEntryPoints', () => {
  it.each([
    ['ja', ja],
    ['en', en],
  ] as const)('%s: 4 つのガイド (導入前チェックリスト・決済QR・レジ・モバイルオーダー・クリエイター) の下に「すべてのガイドを見る」', async (locale, messages) => {
    localeState.value = locale;
    const { container } = render(await LandingEntryPoints());
    const l = messages.Landing;
    const nav = guideNavFor(locale);

    expect(screen.getByRole('heading', { level: 3, name: l.entryTitle })).toBeInTheDocument();
    // 名前と説明はハブ・目次と同じ lib/guideNav.ts (文言の出どころを 1 つに)。導入前チェックリストが先頭。
    const slugs = ['start', 'qr', 'shop', 'store'] as const;
    const list = screen.getByRole('list');
    const tiles = within(list).getAllByRole('link');
    expect(tiles.map((a) => a.getAttribute('href'))).toEqual(slugs.map((slug) => `/${locale}/guide/${slug}`));
    slugs.forEach((slug, index) => {
      expect(tiles[index].textContent).toContain(nav.items[slug].label);
      expect(tiles[index].textContent).toContain(nav.items[slug].summary);
    });

    const all = screen.getByRole('link', { name: l.entryAllGuides });
    expect(all).toHaveAttribute('href', `/${locale}/guide`);
    expect(all.textContent).toBe(l.entryAllGuides);
    // タイルの後ろ (リストの外) に置く。
    expect(list.contains(all)).toBe(false);
    expect(list.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(5);

    // 可視テキストを含まない aria-label を足さない (掟 8)。
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });
});
