// /guide/sell の注意書きの URL リンク。文の途中の URL (Arc の売上を受け取るページ) で、後ろの文章までリンク先に
// 入って 404 になった (2026-10-21)。リンク先は URL ぴったりで、文章はリンクの外に残ること。
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import GuideSellPage from '@/app/[locale]/guide/sell/page';
import { SELL_GUIDE_STARTER_KIT_JA, sellGuideContentFor } from '@/lib/sellGuide';
import { EXTERNAL_PURCHASES, FIRST_PARTY_WALLETS } from '@/lib/externalPurchases';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

describe('/guide/sell の注意書きのリンク', () => {
  it.each(['ja', 'en'] as const)('%s: Arc の売上を受け取るページへのリンク先は URL ぴったり', async (locale) => {
    render(await GuideSellPage({ params: Promise.resolve({ locale }) }));
    const url = `https://open-pay.jp/${locale}/discovery/arc-payout`;
    const link = screen.getByRole('link', { name: url });
    expect(link).toHaveAttribute('href', url);
    // リンクの後ろの文章 (手数料の説明) はリンクの外に残る
    const paragraph = link.closest('p')!;
    expect(paragraph.textContent).toContain(locale === 'ja' ? 'Circle の手数料' : 'Circle’s fee');
    expect(link.textContent).toBe(url);
  });

  it.each(['ja', 'en'] as const)('%s: 注意書きの全リンクは空白やかっこを含まない', async (locale) => {
    render(await GuideSellPage({ params: Promise.resolve({ locale }) }));
    const hrefs = sellGuideContentFor(locale).bazaarNote.flatMap((note) => note.match(/https:\/\/[^\s()]+/g) ?? []);
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) {
      expect(screen.getByRole('link', { name: href })).toHaveAttribute('href', href);
    }
  });
});

// 2026-10-30 (user 裁定): 実売の事例は外部の買い手による購入。件数・金額は誇る規模ではないので載せず、全件は
// /transparency に任せる。名前を出す Japan Web3 Directory は、Base の 0.02 USDC がこの API (一覧・検索) だけの価格で、
// 外部の買い手の 0.02 USDC の精算が SOT にあることが根拠。Coo-ICP は手順の実例で、運営者の動作確認 (note のキットと
// 同じ書き方) なので実売とは呼ばない。有料キットは日本語の有料記事なので ja の出品の帯の下段だけに出す。
describe('/guide/sell の実売の事例・手順の実例・有料キット', () => {
  it.each(['ja', 'en'] as const)('%s: 実売は外部の買い手による購入として先に出し、件数は出さずに運用透明性へリンクする', async (locale) => {
    render(await GuideSellPage({ params: Promise.resolve({ locale }) }));
    const c = sellGuideContentFor(locale);
    const card = screen.getByRole('heading', { name: c.proofExternalTitle }).closest('div')!;
    expect(card.textContent).toContain('Japan Web3 Directory');
    // 件数は出さない (「1 件ずつ確かめられます」は件数ではない)。
    expect(card.textContent).not.toMatch(/\d+ ?件(?!ずつ)|\d+ (purchases|buyers)/);
    expect(within(card).getByRole('link', { name: c.proofExternalLink.label })).toHaveAttribute('href', `/${locale}/transparency`);
    // 実売 (外部の購入) を先に、手順の実例 (Coo-ICP) を後に出す。
    const example = screen.getByRole('heading', { name: c.proofExampleLabel });
    expect(card.compareDocumentPosition(example) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('根拠: 外部の買い手の 0.02 USDC (Japan Web3 Directory の価格) の精算が SOT にある', () => {
    const firstParty = new Set(FIRST_PARTY_WALLETS);
    expect(EXTERNAL_PURCHASES.some((r) => r.amount === '0.02' && !firstParty.has(r.payer.toLowerCase()))).toBe(true);
  });

  it.each(['ja', 'en'] as const)('%s: Coo-ICP の購入は運営者の動作確認と書き、実売とは呼ばない', async (locale) => {
    render(await GuideSellPage({ params: Promise.resolve({ locale }) }));
    const c = sellGuideContentFor(locale);
    // 手順の実例 (Coo-ICP) の箱だけを見る (節の見出し「実売の事例」は外部の購入を指す)。
    const card = screen.getByRole('heading', { name: c.proofExampleLabel }).closest('div')!;
    expect(card.textContent).toContain(locale === 'ja' ? '出品と購入は、運営者による動作確認です。' : 'made by the operator as a test');
    expect(card.textContent).not.toMatch(locale === 'ja' ? /実売|実購入/ : /real (sale|purchase)|first sale/i);
  });

  it('ja: 出品の帯の下段に有料キットへのリンクを出す (別タブ)', async () => {
    render(await GuideSellPage({ params: Promise.resolve({ locale: 'ja' }) }));
    const link = screen.getByRole('link', { name: SELL_GUIDE_STARTER_KIT_JA.link.label });
    expect(link).toHaveAttribute('href', 'https://note.com/masia02/n/n22f55307a0b7');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.closest('p')!.textContent).toContain('このガイドだけで出品できます。');
  });

  it('en: 有料キット (日本語の記事) へのリンクは出さない', async () => {
    const { container } = render(await GuideSellPage({ params: Promise.resolve({ locale: 'en' }) }));
    expect(container.querySelector('a[href="https://note.com/masia02/n/n22f55307a0b7"]')).toBeNull();
  });
});
