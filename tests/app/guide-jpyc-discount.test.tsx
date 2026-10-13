// /guide/qr の節「JPYC 払いで割引する」(2026-10-13・JPYC 社の 10/09 の発表を受けて)。
// - 利用料の後・対応通貨の前に、#jpyc-discount で飛べる見出しで出す (/guide/shop の詳しい操作ガイドからリンク)
// - 注意の囲み: JPYC 社の考え方で公取委の見解ではないこと・OpenPay は個々の規約で割引できるか判断しないこと・発表へのリンク
//   (相談窓口のメールアドレスは載せない)
// - ガイドが引用する画面の文言 (＋ 値引きを追加・ポスターの補足文・モバイル注文・値引き（任意）・設定) が画面と同じ
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
import GuideQrPage from '@/app/[locale]/guide/qr/page';
import GuideShopPage from '@/app/[locale]/guide/shop/page';
import { qrGuideContentFor } from '@/lib/qrGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

type Page = (props: { params: Promise<{ locale: string }> }) => Promise<React.ReactElement>;
const RELEASE = 'https://prtimes.jp/main/html/rd/p/000000332.000054018.html';

describe('/guide/qr の「JPYC 払いで割引する」', () => {
  it.each(['ja', 'en'] as const)('%s: 利用料の後・対応通貨の前に #jpyc-discount で出し、注意の囲みに発表へのリンクを置く', async (locale) => {
    const c = qrGuideContentFor(locale);
    const { container } = render(await (GuideQrPage as Page)({ params: Promise.resolve({ locale }) }));
    const heading = screen.getByRole('heading', { level: 2, name: c.discountTitle });
    expect(heading).toHaveAttribute('id', 'jpyc-discount');
    const h2s = [...container.querySelectorAll('h2')].map((h) => h.getAttribute('data-toc-label'));
    expect(h2s.indexOf(c.discountTitle)).toBe(h2s.indexOf(c.feeTitle) + 1);
    expect(h2s.indexOf(c.currenciesTitle)).toBe(h2s.indexOf(c.discountTitle) + 1);

    const section = heading.closest('section')!;
    for (const point of c.discountPoints) expect(section).toHaveTextContent(point);
    expect(section).toHaveTextContent(c.discountCaution);
    const link = screen.getByRole('link', { name: c.discountSourceLabel });
    expect(link).toHaveAttribute('href', RELEASE);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // 窓口のメールアドレスは載せない (発表へのリンクだけ)。
    expect(section.textContent).not.toMatch(/@|mailto/);
    expect(section.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('注意の囲みは、JPYC 社の考え方であること・公取委の見解ではないこと・OpenPay は判断しないことを書く (断定しない)', () => {
    const jaC = qrGuideContentFor('ja');
    expect(jaC.discountCaution).toContain('これは JPYC 社の考え方で、公正取引委員会の見解ではありません。');
    expect(jaC.discountCaution).toContain('OpenPay は、個々の規約のもとで割引ができるかどうかは判断しません。');
    expect(jaC.discountCaution).toContain('契約している規約を確かめてください');
    const enC = qrGuideContentFor('en');
    expect(enC.discountCaution).toContain('not that of the Japan Fair Trade Commission');
    expect(enC.discountCaution).toContain('OpenPay does not judge whether a discount is allowed');
    // 消費税は控えに出る額に限る (お店の納税額の計算までは言わない・/legal-check 5)。
    expect(jaC.discountPoints.join('')).toContain('控えに出る消費税');
    expect(enC.discountPoints.join('')).toContain('consumption tax shown on receipts');
  });

  it('ガイドが引用する画面の文言は、画面の文言と同じ', () => {
    const jaText = [qrGuideContentFor('ja').discountLead, ...qrGuideContentFor('ja').discountPoints].join('\n');
    expect(jaText).toContain(`「${ja.Discount.add}」`);
    expect(jaText).toContain(`「${ja.QrGenerator.shopSettings.open}」の「${ja.QrGenerator.posterNoteLabel.replace(' (任意)', '')}」`);
    expect(jaText).toContain(`「${ja.Create.tabs.mobileOrder}」タブの「${ja.MobileOrder.discountGroup}」`);
    const enText = [qrGuideContentFor('en').discountLead, ...qrGuideContentFor('en').discountPoints].join('\n');
    expect(enText).toContain(`“${en.Discount.add}”`);
    expect(enText).toContain(`“${en.QrGenerator.posterNoteLabel.replace(' (optional)', '')}” under ${en.QrGenerator.shopSettings.open}`);
    expect(enText).toContain(`“${en.MobileOrder.discountGroup}” in the ${en.Create.tabs.mobileOrder} tab`);
  });

  it.each(['ja', 'en'] as const)('%s: /guide/shop の詳しい操作ガイドから #jpyc-discount へリンクする', async (locale) => {
    render(await (GuideShopPage as Page)({ params: Promise.resolve({ locale }) }));
    const label = locale === 'ja' ? 'JPYC 払いで割引する' : 'Discounts for paying with JPYC';
    const link = screen.getByRole('link', { name: new RegExp(label) });
    expect(link).toHaveAttribute('href', `/${locale}/guide/qr#jpyc-discount`);
  });
});
