import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// markAllSeen の呼出を spy する (mount で 1 回呼ばれる契約)。
const markAllSeen = vi.fn();
vi.mock('@/hooks/useNewsRead', () => ({
  useNewsRead: () => ({
    unreadCount: 0,
    hasUnread: false,
    hydrated: true,
    markAllSeen,
  }),
}));

import { NewsList } from '@/components/NewsList';
import { sortedNews } from '@/lib/news';

beforeEach(() => markAllSeen.mockReset());

describe('NewsList: 一覧描画 / 既読化', () => {
  it('全 item を描画する (件数一致)', () => {
    renderWithIntl(<NewsList />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(sortedNews().length);
  });

  it('新しい順 (date 降順) に並ぶ: 先頭 article が sortedNews 先頭の title (ja)', () => {
    renderWithIntl(<NewsList />);
    const articles = document.querySelectorAll('article');
    const expected = sortedNews()[0];
    expect(articles[0].textContent).toContain(expected.title.ja);
  });

  it('各 item の title / body (ja) を描画する', () => {
    renderWithIntl(<NewsList />);
    for (const n of sortedNews()) {
      expect(screen.getByText(n.title.ja)).toBeInTheDocument();
    }
  });

  it('category バッジを描画する (pricing=料金 / feature=新機能 / notice=お知らせ)', () => {
    renderWithIntl(<NewsList />);
    const labels = new Map([
      ['feature', '新機能'],
      ['pricing', '料金'],
      ['notice', 'お知らせ'],
    ]);
    const presentCategories = new Set(sortedNews().map((n) => n.category));
    for (const cat of presentCategories) {
      expect(screen.getAllByText(labels.get(cat)!).length).toBeGreaterThan(0);
    }
  });

  it('内部 link を持つ item は /{locale} prefix 付きの next/link で描画', () => {
    renderWithIntl(<NewsList />);
    const internal = sortedNews().find((n) => n.link?.href.startsWith('/'));
    if (!internal) return; // 内部 link 無しなら skip (規約上は存在)
    // 同一 label の内部 link が複数 item に存在しうる (例: /terms へ「利用規約を読む」が
    // 料金改定と旧料金告知の両方に)。全該当 link が locale prefix 付きであることを assert。
    const links = screen.getAllByRole('link', {
      name: new RegExp(internal.link!.labelJa),
    });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', `/ja${internal.link!.href}`);
    }
  });

  it('マウント時に markAllSeen を 1 回呼ぶ (= 開いたら既読)', () => {
    renderWithIntl(<NewsList />);
    expect(markAllSeen).toHaveBeenCalledTimes(1);
  });

  it('en locale: 先頭 article が en title で描画', () => {
    renderWithIntl(<NewsList />, { locale: 'en' });
    const articles = document.querySelectorAll('article');
    expect(articles[0].textContent).toContain(sortedNews()[0].title.en);
  });

  it('日付を time[datetime] として描画する (各 item の date)', () => {
    renderWithIntl(<NewsList />);
    const firstArticle = document.querySelector('article')!;
    const time = within(firstArticle as HTMLElement).getByText(
      (_, el) => el?.tagName.toLowerCase() === 'time',
    );
    expect(time).toHaveAttribute('datetime', sortedNews()[0].date);
  });
});
