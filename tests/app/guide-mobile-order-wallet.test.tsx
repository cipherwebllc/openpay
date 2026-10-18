// /guide/mobile-order の「ウォレットを選ぶ」を実描画で検証する: 「用意するもの」の次に置く・「JPYC で支払う」と同じ
// 短い案内と /guide/wallet へのリンク (lib/walletGuide.ts を共用・2026-10-13 にページへ分けた)・
// 関連ガイドに「JPYC で支払う」(/guide/pay)・aria-label を使わないこと (掟 8)。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import GuideMobileOrderPage from '@/app/[locale]/guide/mobile-order/page';
import { mobileOrderGuideContentFor } from '@/lib/mobileOrderGuide';
import { guideNavFor } from '@/lib/guideNav';
import { walletGuideContentFor } from '@/lib/walletGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide/mobile-order のウォレットの案内', () => {
  it.each(['ja', 'en'] as const)('%s: 用意するものの次に「ウォレットを選ぶ」・関連ガイドに JPYC で支払う', async (locale) => {
    const c = mobileOrderGuideContentFor(locale);
    const w = walletGuideContentFor(locale);
    const { container } = render(await GuideMobileOrderPage({ params: Promise.resolve({ locale }) }));
    const article = container.querySelector('article')!;

    const nav = guideNavFor(locale);
    const h2 = within(article).getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2.indexOf(nav.items.wallet.label)).toBe(h2.indexOf(c.needTitle) + 1);

    // 「JPYC で支払う」と同じ短い案内と /guide/wallet へのリンク (選び方・QR の読み取り方・つなぎ方はそのページ)。
    const sec = screen.getByRole('heading', { level: 2, name: nav.items.wallet.label }).closest('section')!;
    expect(within(sec).getByText(w.summary)).toBeInTheDocument();
    expect(within(sec).getByRole('link', { name: w.summaryLink })).toHaveAttribute('href', `/${locale}/guide/wallet`);

    // 用意するもののウォレットの項目から「ウォレットを選ぶ」へ誘導する。
    expect(c.need.some((item) => item.includes('HashPort Wallet') && item.includes(nav.items.wallet.label))).toBe(true);

    // 関連ガイド: JPYC で支払う。AI で注文 (/guide/agent) は「次へ」と同じ行き先なので 1 行には重ねない。
    const related = screen.getByRole('heading', { level: 2, name: nav.relatedGuidesTitle }).closest('section')!;
    expect(within(related).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [nav.items.pay.label, `/${locale}/guide/pay`],
    ]);
    expect(screen.getByRole('link', { name: new RegExp(`^${nav.nextLabel}`) })).toHaveAttribute('href', `/${locale}/guide/agent`);

    expect(container.querySelectorAll('article [aria-label]')).toHaveLength(0);
  });
});
