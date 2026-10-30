import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { renderWithIntl } from '../_helpers/i18n';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

// 全レビュー第 8 回 D-4: nav のランドマーク名 (TopNav・BottomNav・SiteFooter) が messages の外の英語の直書きで、
// AlphaNotice の閉じるボタンはロケールの自前分岐だった。/ja のページでランドマーク一覧を開くと英語が読まれる。
// i18n の parity テストは messages/ だけを見るので、名前が messages から来ることをここで固定する。

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePathname: () => '/ja',
}));

import { BottomNav } from '@/components/BottomNav';
import { TopNav } from '@/components/TopNav';
import { SiteFooter } from '@/components/SiteFooter';
import { AlphaNotice } from '@/components/AlphaNotice';

const messages = { ja, en } as const;

describe('ランドマーク名と閉じるボタンの名前は messages から (D-4)', () => {
  it('ja と en で名前が違う (どちらかの言語の直書きでない)', () => {
    expect(ja.Nav.primaryNavLabel).not.toBe(en.Nav.primaryNavLabel);
    expect(ja.Nav.bottomNavLabel).not.toBe(en.Nav.bottomNavLabel);
    expect(ja.Footer.navLabel).not.toBe(en.Footer.navLabel);
    expect(ja.AlphaNotice.dismiss).not.toBe(en.AlphaNotice.dismiss);
  });

  describe.each(['ja', 'en'] as const)('%s', (locale) => {
    const m = messages[locale];

    it('TopNav: Nav.primaryNavLabel', () => {
      renderWithIntl(<TopNav />, { locale });
      expect(screen.getByRole('navigation', { name: m.Nav.primaryNavLabel })).toBeInTheDocument();
    });

    it('BottomNav: Nav.bottomNavLabel', () => {
      renderWithIntl(<BottomNav />, { locale });
      expect(screen.getByRole('navigation', { name: m.Nav.bottomNavLabel })).toBeInTheDocument();
    });

    it('SiteFooter: Footer.navLabel', () => {
      renderWithIntl(<SiteFooter />, { locale });
      const nav = screen.getByRole('navigation', { name: m.Footer.navLabel });
      // 規約へのリンクが入った nav にその名前が付いている
      expect(nav.querySelector('a[href="/terms"]')).not.toBeNull();
    });

    it('AlphaNotice: 閉じるボタンは AlphaNotice.dismiss', () => {
      renderWithIntl(<AlphaNotice />, { locale });
      expect(screen.getByRole('button', { name: m.AlphaNotice.dismiss })).toBeInTheDocument();
    });
  });

  // 値が以前の直書きと同じキー (AlphaNotice.dismiss の「閉じる」/「Dismiss」) もあるので、messages の値を目印に
  // 差し替えて、名前がその値になる (= 直書きでなく messages から読んでいる) ことを確かめる。
  it('messages の値を差し替えると名前もその値になる', () => {
    const marked = {
      ...ja,
      Nav: { ...ja.Nav, primaryNavLabel: '目印-primary', bottomNavLabel: '目印-bottom' },
      Footer: { ...ja.Footer, navLabel: '目印-footer' },
      AlphaNotice: { ...ja.AlphaNotice, dismiss: '目印-dismiss' },
    };
    render(
      <NextIntlClientProvider locale="ja" messages={marked}>
        <TopNav />
        <BottomNav />
        <SiteFooter />
        <AlphaNotice />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('navigation', { name: '目印-primary' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '目印-bottom' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '目印-footer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '目印-dismiss' })).toBeInTheDocument();
  });
});
