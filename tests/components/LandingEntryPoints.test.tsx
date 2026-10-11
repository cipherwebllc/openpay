// トップ「用途から選ぶ」の 3 入口と、その下の全ガイドのハブ (/guide) へのリンク。
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
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
  ] as const)('%s: 3 入口の下に「すべてのガイドを見る」→ /{locale}/guide (名前は可視テキストだけ)', async (locale, messages) => {
    localeState.value = locale;
    const { container } = render(await LandingEntryPoints());
    const l = messages.Landing;

    const all = screen.getByRole('link', { name: l.entryAllGuides });
    expect(all).toHaveAttribute('href', `/${locale}/guide`);
    expect(all.textContent).toBe(l.entryAllGuides);
    // 3 タイルの後ろ (リストの外) に置く。
    const list = screen.getByRole('list');
    expect(list.contains(all)).toBe(false);
    expect(list.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 既存の 3 入口はそのまま。
    const tiles = [
      [l.entryQrTitle, l.entryQrBody, `/${locale}/guide/qr`],
      [l.entryShopTitle, l.entryShopBody, `/${locale}/guide/shop`],
      [l.entryCreatorTitle, l.entryCreatorBody, `/${locale}/guide/store`],
    ];
    for (const [title, body, href] of tiles) {
      const tile = screen.getByRole('link', { name: (name) => name.includes(title) && name.includes(body) });
      expect(tile).toHaveAttribute('href', href);
    }
    expect(screen.getAllByRole('link')).toHaveLength(4);

    // 可視テキストを含まない aria-label を足さない (掟 8)。
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });
});
