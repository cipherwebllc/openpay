// /guide/history の描画: 本文の節・上限の件数 (HISTORY_MAX_ENTRIES)・「取引履歴を開く」は /history へ・aria-label を使わない (掟 8)。
// 決済QR (/guide/qr) とお店 (/guide/shop) のガイドの「売上履歴」の項目は、「いつでも」を言わず、履歴に出ない入金があることと、
// このガイドへのリンク (名前は目次と同じ可視の文字) を出す。

import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { HISTORY_MAX_ENTRIES } from '@/lib/history';
import { guideNavFor } from '@/lib/guideNav';
import { historyGuideContentFor } from '@/lib/historyGuide';
import { qrGuideContentFor } from '@/lib/qrGuide';
import { shopGuideContentFor } from '@/lib/shopGuide';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn(), getTranslations: async () => (key: string) => key }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

type Page = (props: { params: Promise<{ locale: string }> }) => Promise<React.ReactElement>;
const load = async (slug: 'history' | 'qr' | 'shop'): Promise<Page> =>
  (await import(`@/app/[locale]/guide/${slug}/page`)).default as Page;

describe('/guide/history', () => {
  it.each(['ja', 'en'] as const)('%s: 見出し・節・上限の件数・/history へのボタン', async (locale) => {
    const Page = await load('history');
    const { container } = render(await Page({ params: Promise.resolve({ locale }) }));
    const c = historyGuideContentFor(locale);
    const nav = guideNavFor(locale);
    const article = container.querySelector('article')!;

    expect(screen.getByRole('heading', { level: 1, name: nav.items.history.label })).toBeInTheDocument();
    expect(article).toHaveTextContent(c.lead);
    const h2s = [...article.querySelectorAll('h2:not([data-toc="skip"])')].map((h) => h.getAttribute('data-toc-label'));
    expect(h2s).toEqual([c.inHistoryTitle, c.notInHistoryTitle, c.csvTitle, c.storageTitle]);
    // 出る払い方は ①②③ の印つき (印は可視の文字・下の 1 行が「① は…」と指す)。
    const inList = within(article).getByText(c.inHistory[0].text).closest('ol')!;
    expect([...inList.querySelectorAll('li')].map((li) => li.textContent)).toEqual(
      c.inHistory.map((item) => `${item.mark}${item.text}`),
    );
    expect(article).toHaveTextContent(c.inHistoryNote);
    for (const item of c.notInHistory) {
      expect(within(article).getByText(item)).toBeInTheDocument();
    }
    expect(article).toHaveTextContent(c.notInHistoryCheck);
    expect(article).toHaveTextContent(c.csvBody);
    expect(article).toHaveTextContent(c.storageBody);
    expect(c.storageBody).toContain(HISTORY_MAX_ENTRIES.toLocaleString('en-US'));

    // ページの頭と末尾の帯の 2 つ。どちらも /history へ。
    const open = screen.getAllByRole('link', { name: c.ctaOpen });
    expect(open).toHaveLength(2);
    for (const a of open) expect(a).toHaveAttribute('href', `/${locale}/history`);

    // 関連ガイド (本文の中・目次の nav の外): 決済QR・レジとモバイルオーダー・導入前チェックリスト (前へ / 次へと重ねない)。
    for (const slug of ['qr', 'shop', 'start'] as const) {
      expect(within(article).getByRole('link', { name: nav.items[slug].label })).toHaveAttribute('href', `/${locale}/guide/${slug}`);
    }
    expect(article.querySelectorAll('[aria-label]')).toHaveLength(0);
  });
});

describe('決済QR・お店のガイドの「売上履歴」の項目', () => {
  it.each([
    ['qr', 'ja'],
    ['qr', 'en'],
    ['shop', 'ja'],
    ['shop', 'en'],
  ] as const)('/guide/%s (%s): 履歴に出ない入金があると書き、取引履歴のガイドへ続く', async (slug, locale) => {
    const Page = await load(slug);
    render(await Page({ params: Promise.resolve({ locale }) }));
    const features = (slug === 'qr' ? qrGuideContentFor(locale) : shopGuideContentFor(locale)).features;
    const linked = features.filter((f) => f.guide === 'history');
    expect(linked).toHaveLength(1);
    const feature = linked[0];
    expect(feature.body).toContain(locale === 'ja' ? '(履歴に出ない入金もあります)' : '(some incoming payments do not show up in it)');
    expect(feature.body).not.toMatch(locale === 'ja' ? /いつでも/ : /anytime/);

    const item = screen.getByRole('heading', { level: 3, name: feature.title }).closest('li')!;
    const link = within(item).getByRole('link', { name: guideNavFor(locale).items.history.label });
    expect(link).toHaveAttribute('href', `/${locale}/guide/history`);
    expect(link).not.toHaveAttribute('aria-label');
  });
});
