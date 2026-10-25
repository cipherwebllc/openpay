// 料金ページ (/pricing) の描画。今の正本の値で描く。
// 横はみ出し (390px) と breakpoint の並びは jsdom では見られないので e2e/pricing.spec.ts と実機スクショで見る。
// 計算機の操作は tests/components/PricingCalculator.test.tsx。

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PricingPage, { generateMetadata } from '@/app/[locale]/pricing/page';
import { PRICING, PRICING_ROW_GROUPS, PRICING_ROW_IDS } from '@/lib/pricing';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

describe.each(['ja', 'en'] as const)('%s /pricing', (locale) => {
  const content = PRICING[locale];

  async function renderPage() {
    return render(await PricingPage({ params: Promise.resolve({ locale }) }));
  }

  it('見出しの並び: h1 → 4 つの場合 (h3) → 計算機の 4 場面 (h3) → 払う人のまとまり (h3) → 機能ごとの 5 行 (h4)', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: content.title })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      content.summaryTitle,
      content.calc.title,
      content.feesTitle,
      content.otherTitle,
    ]);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      ...content.summary.map((item) => item.name),
      ...content.calc.modes.map((mode) => mode.name),
      ...PRICING_ROW_GROUPS.map((group) => content.rowGroupTitles[group.id]),
    ]);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(content.rows.map((row) => row.name));
  });

  it('機能ごとの表は払う人のまとまり (お店 / チップを送る方 / デジタル商品・AI の買い手) に分かれ、各行は 1 回ずつ', async () => {
    const { container } = await renderPage();
    const fees = container.querySelector<HTMLElement>('section[aria-labelledby="pricing-fees"]');
    if (!fees) throw new Error('fees section');
    expect(PRICING_ROW_GROUPS.flatMap((group) => group.rowIds)).toEqual([...PRICING_ROW_IDS]);
    for (const group of PRICING_ROW_GROUPS) {
      const groupItem = within(fees).getByRole('heading', { level: 3, name: content.rowGroupTitles[group.id] }).closest('li');
      if (!groupItem) throw new Error(group.id);
      expect(within(groupItem).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(
        group.rowIds.map((id) => content.rows.find((row) => row.id === id)?.name),
      );
    }
  });

  it('冒頭の文・4 つの場合の料率と払う人・2 つの安心材料・最低額の説明', async () => {
    const { container } = await renderPage();
    for (const text of [content.lead, ...content.trust, content.calc.floorNote]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    const summary = container.querySelector<HTMLElement>('section[aria-labelledby="pricing-summary"]');
    if (!summary) throw new Error('summary section');
    for (const item of content.summary) {
      const card = within(summary).getByRole('heading', { level: 3, name: item.name }).closest('li');
      if (!card) throw new Error(item.id);
      expect(within(card).getByText(item.focal)).toBeInTheDocument();
      expect(within(card).getByText(item.feeName)).toBeInTheDocument();
      expect(within(card).getByText(item.payer.label)).toBeInTheDocument();
    }
  });

  it('機能ごとの 5 行: dl の dt・値・払う人・「くわしく」の中の文', async () => {
    const { container } = await renderPage();
    const rowLists = container.querySelectorAll('li dl');
    expect(rowLists).toHaveLength(content.rows.length);
    expect(content.rows).toHaveLength(5);
    for (const list of rowLists) {
      expect([...list.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
        content.dtStandard,
        content.dtGasless,
        content.dtPayer,
      ]);
    }
    content.rows.forEach((row, index) => {
      const item = rowLists[index].closest('li');
      if (!item) throw new Error(row.id);
      const text = item.textContent ?? '';
      for (const value of [...row.standard, ...row.gasless]) expect(text, row.id).toContain(value.value);
      for (const payer of row.payers) expect(text, row.id).toContain(payer.label);
      const details = item.querySelector('details');
      // 見える文字は「くわしく」・読み上げは機能名つき (5 つを区別する)。
      expect(details?.querySelector('summary')?.textContent).toBe(`${content.detailsLabel}（${row.name}）`);
      for (const detail of row.details) expect(details?.textContent, row.id).toContain(detail);
    });
    // スマホで見出しの行の代わりに 2 つの決済の意味を書く (md 以上は読み上げだけ)。
    expect(screen.getByText(content.dtStandardDef, { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(content.dtGaslessDef, { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(content.dtPayerDef, { selector: 'dd' })).toBeInTheDocument();
  });

  it('計算機は 1,000 JPYC で描かれ、引き算 (お店が払う) と足し算 (買い手が払う) を出す', async () => {
    await renderPage();
    expect(screen.getByLabelText(content.calc.amountLabel)).toHaveValue('1,000');
    const results = screen.getByRole('heading', { level: 3, name: content.calc.modes[0].name }).closest('ul');
    if (!results) throw new Error('results');
    const text = results.textContent ?? '';
    expect(text).toContain('−');
    expect(text).toContain('+');
    expect(text).toContain('990');
    expect(text).toContain('1,010');
  });

  it('このほかの場合は見出しだけを並べ、本文はたたむ', async () => {
    await renderPage();
    content.otherTitles.forEach((title, index) => {
      const summary = screen.getByText(title, { selector: 'summary' });
      expect(summary.closest('details')?.textContent).toContain(content.otherItems[index]);
    });
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
