// ガイド共通の目次 (components/guide/GuideFrame.tsx) を実描画で検証する。
// next-intl / AppShell に依存しない同期部品なのでモックなし。jsdom は CSS を当てないので、
// PC (hidden lg:block) とスマホ (lg:hidden) の 2 つの nav がどちらも見える前提で数える。
// breakpoint での出し分けと <details> の開閉は e2e/guide-nav.spec.ts が見る。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GuideFrame } from '@/components/guide/GuideFrame';
import { GUIDE_SLUGS, guideNavFor } from '@/lib/guideNav';

// prefetch の指定を DOM で見えるようにする (既定のままだと PC で 1 ページごとに他のガイド約 12 本の RSC を先読みする)。
vi.mock('next/link', () => ({
  default: ({ prefetch, children, ...rest }: { prefetch?: boolean; children: React.ReactNode; href: string }) => (
    <a data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

function renderFrame(locale: string, current: (typeof GUIDE_SLUGS)[number]) {
  return render(
    <GuideFrame locale={locale} current={current}>
      <article>
        <h1>本文</h1>
      </article>
    </GuideFrame>,
  );
}

describe('GuideFrame', () => {
  it.each(['ja', 'en'] as const)('%s: 「ガイド一覧」の nav が 2 つ (PC・スマホ) あり、名前は可視テキストから', (locale) => {
    const nav = guideNavFor(locale);
    renderFrame(locale, 'qr');
    const navs = screen.getAllByRole('navigation', { name: nav.navTitle });
    expect(navs).toHaveLength(2);
    // 本文はそのまま描かれる
    expect(screen.getByRole('heading', { level: 1, name: '本文' })).toBeInTheDocument();
    // グループ名は見出しにしない (本文の h1 より先に見出しが並ばない)
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it.each(GUIDE_SLUGS)('current=%s のリンクだけが aria-current="page" (2 つの nav で 1 個ずつ)', (slug) => {
    const { container } = renderFrame('ja', slug);
    const currentLinks = container.querySelectorAll('a[aria-current="page"]');
    expect(currentLinks).toHaveLength(2);
    for (const link of currentLinks) {
      expect(link).toHaveAttribute('href', `/ja/guide/${slug}`);
      expect(link).toHaveTextContent(guideNavFor('ja').items[slug].label);
    }
  });

  it.each(['ja', 'en'] as const)('%s: 各 nav は先頭がハブ、続いて 12 本のガイドへのリンク', (locale) => {
    const nav = guideNavFor(locale);
    renderFrame(locale, 'store');
    for (const landmark of screen.getAllByRole('navigation', { name: nav.navTitle })) {
      const links = within(landmark).getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        `/${locale}/guide`,
        ...GUIDE_SLUGS.map((slug) => `/${locale}/guide/${slug}`),
      ]);
      expect(links[0]).toHaveTextContent(nav.hubTitle);
      // グループの一覧は可視のグループ名を名前に持つ
      for (const group of nav.groups) {
        expect(within(landmark).getByRole('list', { name: group.title })).toBeInTheDocument();
      }
    }
  });

  it('スマホのバー (summary) は「ガイド一覧」と今のガイド名を出す', () => {
    const { container } = renderFrame('ja', 'sell');
    const summary = container.querySelector('details > summary');
    expect(summary).not.toBeNull();
    expect(summary).toHaveTextContent('ガイド一覧');
    expect(summary).toHaveTextContent('API を売る');
    // 閉じた状態で描く (開くのは利用者の操作だけ)
    expect(container.querySelector('details')).not.toHaveAttribute('open');
  });

  it('aria-label を 1 つも使わず (掟 8)、id は重複しない', () => {
    const { container } = renderFrame('en', 'agent');
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    // aria-labelledby の参照先はすべて存在する
    for (const el of container.querySelectorAll('[aria-labelledby]')) {
      expect(container.querySelector(`#${el.getAttribute('aria-labelledby')}`)).not.toBeNull();
    }
  });

  it('目次のリンクは prefetch しない設定で、印刷では目次を消して grid も解く', () => {
    const { container } = renderFrame('ja', 'qr');
    const links = [...container.querySelectorAll('a')];
    // PC とスマホの 2 つの nav × (ハブ 1 本 + ガイド全部) + 本文の後の「前へ / 次へ」2 本。
    expect(links).toHaveLength(2 * (1 + GUIDE_SLUGS.length) + 2);
    for (const link of links) expect(link).toHaveAttribute('data-prefetch', 'false');
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toContain('lg:grid');
    expect(frame.className).toContain('print:block');
    for (const landmark of container.querySelectorAll('nav')) {
      // PC の nav は print:hidden の列の中、スマホの nav はそれ自体が print:hidden
      expect(landmark.closest('.print\\:hidden')).not.toBeNull();
    }
  });

  it('本文の後の「前へ / 次へ」は目次の並び順・最初の前はハブ・最後に次は無い', () => {
    const nav = guideNavFor('ja');
    const pager = (slug: (typeof GUIDE_SLUGS)[number]) => {
      const { container, unmount } = renderFrame('ja', slug);
      const links = [...container.querySelectorAll('a')].filter(
        (a) => a.textContent?.startsWith(nav.prevLabel) || a.textContent?.startsWith(nav.nextLabel),
      );
      const result = links.map((a) => [a.textContent?.startsWith(nav.prevLabel) ? 'prev' : 'next', a.getAttribute('href')]);
      unmount();
      return result;
    };
    expect(pager('start')).toEqual([
      ['prev', '/ja/guide'],
      ['next', '/ja/guide/qr'],
    ]);
    expect(pager('pay')).toEqual([
      ['prev', '/ja/guide/pos'],
      ['next', '/ja/guide/wallet'],
    ]);
    expect(pager('image-url')).toEqual([['prev', '/ja/guide/sell']]);
  });
});
