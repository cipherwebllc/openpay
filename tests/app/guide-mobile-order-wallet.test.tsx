// /guide/mobile-order の「ウォレットを選ぶ」を実描画で検証する: 「用意するもの」の次に置く・「JPYC で支払う」と同じ
// 文言 (lib/walletGuide.ts を共用)・3 つのウォレットと WalletConnect の 4 手順 (お客様の番号 = blue)・
// 関連ガイドに「JPYC で支払う」(/guide/pay)・aria-label を使わないこと (掟 8)。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import GuideMobileOrderPage from '@/app/[locale]/guide/mobile-order/page';
import { mobileOrderGuideContentFor } from '@/lib/mobileOrderGuide';
import { payGuideContentFor } from '@/lib/payGuide';
import { walletGuideContentFor } from '@/lib/walletGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide/mobile-order のウォレットの案内', () => {
  it.each(['ja', 'en'] as const)('%s: 用意するものの次に「ウォレットを選ぶ」・関連ガイドに JPYC で支払う', async (locale) => {
    const c = mobileOrderGuideContentFor(locale);
    const w = walletGuideContentFor(locale);
    const { container } = render(await GuideMobileOrderPage({ params: Promise.resolve({ locale }) }));
    const article = container.querySelector('article')!;

    // 「JPYC で支払う」と同じ文言 (片方だけ直してずれないよう lib/walletGuide.ts を共用)。
    const pay = payGuideContentFor(locale);
    expect(w.walletTitle).toBe(pay.walletTitle);
    expect(w.wcSteps).toEqual(pay.wcSteps);

    const h2 = within(article).getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2.indexOf(w.walletTitle)).toBe(h2.indexOf(c.needTitle) + 1);

    const sec = screen.getByRole('heading', { level: 2, name: w.walletTitle }).closest('section')!;
    for (const wallet of w.wallets) expect(within(sec).getByText(wallet.name)).toBeInTheDocument();
    expect(w.wallets.map((x) => x.name)).toEqual(locale === 'ja' ? ['MetaMask', 'HashPort Wallet', 'マイナウォレット'] : ['MetaMask', 'HashPort Wallet', 'MynaWallet']);
    expect(within(sec).getByRole('heading', { level: 3, name: w.wcTitle })).toBeInTheDocument();
    const wcList = within(sec).getByText(w.wcSteps[0].title).closest('ol')!;
    const badges = within(wcList).getAllByRole('listitem').map((li) => li.querySelector('span')!);
    expect(badges.map((b) => b.textContent)).toEqual(['1', '2', '3', '4']);
    for (const badge of badges) expect(badge.className).toContain('bg-blue-600');
    // 検索の言葉 (一覧は英語) まで書いてある。
    expect(w.wcSteps[1].body).toContain('HashPort');
    expect(w.wcSteps[1].body).toContain('Myna');

    // 用意するもののウォレットの項目から「ウォレットを選ぶ」へ誘導する。
    expect(c.need.some((item) => item.includes('HashPort Wallet') && item.includes(w.walletTitle))).toBe(true);

    // 関連ガイド: JPYC で支払う → AI で注文。
    const related = screen.getByRole('link', { name: c.relatedPayGuide });
    expect(related).toHaveAttribute('href', `/${locale}/guide/pay`);
    expect(screen.getByRole('link', { name: c.relatedAgentGuide })).toHaveAttribute('href', `/${locale}/guide/agent`);

    expect(container.querySelectorAll('article [aria-label]')).toHaveLength(0);
  });
});
