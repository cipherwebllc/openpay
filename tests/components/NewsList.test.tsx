import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

import { NEWS_LATEST_COUNT, NewsList } from '@/components/NewsList';
import { newsEntriesFor, sortedNews } from '@/lib/news';
import { runtimeClosure, runtimeSpecifiers } from '../_helpers/runtimeImports';

beforeEach(() => markAllSeen.mockReset());

describe('NewsList: 一覧描画 / 既読化', () => {
  it('全 item を描画する (件数一致)', () => {
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(sortedNews().length);
  });

  it('新しい順 (date 降順) に並ぶ: 先頭 article が sortedNews 先頭の title (ja)', () => {
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
    const articles = document.querySelectorAll('article');
    const expected = sortedNews()[0];
    expect(articles[0].textContent).toContain(expected.title.ja);
  });

  it('各 item の title / body (ja) を描画する', () => {
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
    for (const n of sortedNews()) {
      expect(screen.getByText(n.title.ja)).toBeInTheDocument();
    }
  });

  it('category バッジを描画する (pricing=料金 / feature=新機能 / notice=お知らせ)', () => {
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
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
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
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
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
    expect(markAllSeen).toHaveBeenCalledTimes(1);
  });

  it('en locale: 先頭 article が en title で描画', () => {
    renderWithIntl(<NewsList items={newsEntriesFor('en')} />, { locale: 'en' });
    const articles = document.querySelectorAll('article');
    expect(articles[0].textContent).toContain(sortedNews()[0].title.en);
  });

  it('日付を time[datetime] として描画する (各 item の date)', () => {
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
    const firstArticle = document.querySelector('article')!;
    const time = within(firstArticle as HTMLElement).getByText(
      (_, el) => el?.tagName.toLowerCase() === 'time',
    );
    expect(time).toHaveAttribute('datetime', sortedNews()[0].date);
  });
});

describe('NewsList: 最新はカード・古いものはたたむ / 1 件ずつのリンク', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it(`最新 ${NEWS_LATEST_COUNT} 件はカード (article)、残りは閉じた行 (details) で「過去のお知らせ」の下に並ぶ`, () => {
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
    const items = sortedNews();
    const articles = [...document.querySelectorAll('article')];
    expect(articles.map((a) => a.id)).toEqual(items.slice(0, NEWS_LATEST_COUNT).map((n) => n.id));
    const rows = [...document.querySelectorAll('details')];
    expect(rows.map((d) => d.id)).toEqual(items.slice(NEWS_LATEST_COUNT).map((n) => n.id));
    expect(rows.every((d) => !d.open)).toBe(true);
    expect(screen.getByRole('heading', { name: '過去のお知らせ' })).toBeInTheDocument();
  });

  it('たたんだ行の見出しと日付は閉じたままでも見える (summary の中)', () => {
    renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
    const older = sortedNews()[NEWS_LATEST_COUNT];
    const summary = document.getElementById(older.id)!.querySelector('summary')!;
    expect(summary.textContent).toContain(older.title.ja);
    expect(summary.querySelector('time')).toHaveAttribute('datetime', older.date);
  });

  it('/news#<たたんだ行の id> で開くと、その行を開いて表示する', () => {
    const older = sortedNews()[NEWS_LATEST_COUNT + 1];
    window.history.replaceState(null, '', `/ja/news#${older.id}`);
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
      const row = document.getElementById(older.id) as HTMLDetailsElement;
      expect(row.open).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      // ほかの行は閉じたまま
      const others = [...document.querySelectorAll('details')].filter((d) => d.id !== older.id);
      expect(others.every((d) => !d.open)).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('お知らせの id の形でない # (ほかの見出しや壊れた値) では何もしない', () => {
    window.history.replaceState(null, '', '/ja/news#%E0%A4%A');
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect([...document.querySelectorAll('details')].every((d) => !d.open)).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('「リンクをコピー」でそのお知らせの URL (/{locale}/news#<id>) を写す', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    try {
      window.history.replaceState(null, '', '/ja/news');
      renderWithIntl(<NewsList items={newsEntriesFor('ja')} />);
      const first = sortedNews()[0];
      const card = document.getElementById(first.id)!;
      await user.click(within(card).getByRole('button', { name: 'リンクをコピー' }));
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/ja/news#${first.id}`);
      expect(within(card).getByRole('button', { name: '✓ コピーしました' })).toBeInTheDocument();
    } finally {
      writeText.mockRestore();
    }
  });
});

// 2026-11-07: 一覧の部品は lib/news.ts を値として import しない (型だけ)。値で import すると全件の ja/en の本文が /news の
// First Load JS に入り、お知らせを足すたびに bundle 予算を食う。本文は page (server) が newsEntriesFor で絞って渡す。
// 2026-11-08: 行頭の `import type {` を正規表現で見ていたのを、TS の構文木で runtime import を辿る形にした。
// 複数行の import・二重引用符・相対 path・import()・require()・hook や部品を 1 段挟んだ import でも、lib/news.ts に届けば落ちる。
describe('NewsList: 本文を JS に入れない (lib/news.ts は型だけ)', () => {
  it('components/NewsList.tsx から runtime import を辿っても lib/news.ts に届かない', () => {
    const { files } = runtimeClosure(['components/NewsList.tsx']);
    expect(files).toContain('components/NewsList.tsx');
    expect(files).not.toContain('lib/news.ts');
  });

  it('検査は空振りしない: page からは lib/news.ts に届き、値の import は書き方を問わず辿る', () => {
    expect(runtimeClosure(['app/[locale]/news/page.tsx']).files).toContain('lib/news.ts');
    const src = [
      "import type { NewsEntry } from '@/lib/news';",
      'import {',
      '  sortedNews,',
      '} from "../lib/news";',
      "const later = () => import('@/lib/news');",
      "const { NEWS } = require('../../lib/news');",
    ].join('\n');
    expect(runtimeSpecifiers('fixture.tsx', src)).toEqual(['../lib/news', '@/lib/news', '../../lib/news']);
  });

  it('newsEntriesFor は新しい順・その言語の title / body / link だけ', () => {
    for (const locale of ['ja', 'en'] as const) {
      const entries = newsEntriesFor(locale);
      const items = sortedNews();
      expect(entries.map((e) => e.id)).toEqual(items.map((n) => n.id));
      entries.forEach((e, i) => {
        expect(e.title).toBe(items[i].title[locale]);
        expect(e.body).toBe(items[i].body[locale]);
        const link = items[i].link;
        expect(e.link).toEqual(link ? { href: link.href, label: locale === 'ja' ? link.labelJa : link.labelEn } : undefined);
      });
    }
  });
});
