// 料金ページ (/pricing) の描画 (plans/pricing-page.md §7.1 ⑧)。今の正本の値で描く。
// 横はみ出し (390px) と breakpoint の並びは jsdom では見られないので e2e/pricing.spec.ts と実機スクショで見る。

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PricingPage, { generateMetadata } from '@/app/[locale]/pricing/page';
import { PRICING } from '@/lib/pricing';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

describe.each(['ja', 'en'] as const)('%s /pricing', (locale) => {
  const content = PRICING[locale];

  async function renderPage() {
    return render(await PricingPage({ params: Promise.resolve({ locale }) }));
  }

  it('見出し・6 枚のカード (h3 + dl)・dt の文字', async () => {
    const { container } = await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: content.title })).toBeInTheDocument();
    const cardHeadings = screen.getAllByRole('heading', { level: 3 });
    expect(cardHeadings.map((heading) => heading.textContent)).toEqual(content.rows.map((row) => row.name));
    const lists = container.querySelectorAll('dl');
    expect(lists).toHaveLength(6);
    for (const list of lists) {
      expect([...list.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
        content.dtStandard,
        content.dtGasless,
        content.dtPayer,
      ]);
    }
    for (const text of [content.lead, ...content.cases, content.storeGasNote, content.aside]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('計算例の表 3 つ (caption・th[scope])', async () => {
    await renderPage();
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(3);
    tables.forEach((table, index) => {
      const spec = content.examples[index];
      expect(within(table).getByText(spec.caption).tagName).toBe('CAPTION');
      expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([...spec.headers]);
      expect(within(table).getAllByRole('rowheader')).toHaveLength(3);
      for (const th of table.querySelectorAll('th')) expect(th.getAttribute('scope')).toMatch(/^(col|row)$/);
    });
    // 最低額の行は文字で印を付ける (色だけに頼らない)。
    const floor = locale === 'ja' ? '2 JPYC（最低額）' : '2 JPYC (minimum)';
    expect(within(tables[0]).getAllByRole('row').some((row) => row.textContent?.includes(floor))).toBe(true);
  });

  it('aria-label を足さない・リンク先 (トップ・利用規約・特商法表記)', async () => {
    const { container } = await renderPage();
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
    expect(screen.getByRole('link', { name: content.backHome })).toHaveAttribute('href', `/${locale}`);
    const [terms, tokutei] = content.termsLinks;
    expect(screen.getByRole('link', { name: terms.label })).toHaveAttribute('href', `/${locale}/terms`);
    expect(screen.getByRole('link', { name: tokutei.label })).toHaveAttribute('href', `/${locale}/tokutei`);
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });

  it('generateMetadata は lib/pricing の metadata', async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
    expect(meta.title).toBe(content.metaTitle);
    expect(meta.alternates?.canonical).toBe(`/${locale}/pricing`);
  });
});
