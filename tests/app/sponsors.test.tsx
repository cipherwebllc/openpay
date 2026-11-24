// スポンサー・広告掲載のご案内 (/sponsors) の描画。今の正本 (lib/sponsors.ts・lib/sponsorPlans.ts) の値で描く。
// 横はみ出し (390px) と 1 字の折り返しは jsdom では見られないので、実機スクショ (scripts/dev-shot.mjs) で見る。

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SponsorsPage, { generateMetadata } from '@/app/[locale]/sponsors/page';
import sitemap from '@/app/sitemap';
import { OPENPAY_DISCORD_URL, OPENPAY_LINE_URL, OPENPAY_X_URL } from '@/lib/officialLinks';
import { SPONSOR_ANNUAL_PLAN, SPONSOR_BANNER_SPEC, SPONSOR_PLANS } from '@/lib/sponsorPlans';
import { SPONSORS } from '@/lib/sponsors';

vi.mock('next-intl/server', () => ({ setRequestLocale: vi.fn() }));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

/** 数字と単位の間の改行しない空白 (keepNumbersTogether) を、ふつうの空白に戻した文。 */
const plain = (el: Element) => (el.textContent ?? '').replace(/ /g, ' ');

describe.each(['ja', 'en'] as const)('%s /sponsors', (locale) => {
  const c = SPONSORS[locale];

  async function renderPage() {
    return render(await SponsorsPage({ params: Promise.resolve({ locale }) }));
  }

  it('見出しの並び: h1 → 料金 → 掲載イメージ → 入稿仕様 → 掲載条件 → 更新 → 掲載基準 → 返金 → 歓迎事項 → 流れ', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(c.title);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      c.plansTitle,
      c.samplesTitle,
      c.specsTitle,
      c.termsTitle,
      c.renewalTitle,
      c.standardsTitle,
      c.refundTitle,
      c.welcomeTitle,
      c.flowTitle,
    ]);
    // 料金のカード 2 枚と年間プランのカード、掲載イメージの 2 つ (料金のカードと同じ名前)。
    const names = c.plans.map((p) => p.name);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([...names, c.annual.name, ...names]);
  });

  it('承認の文がすべて描かれる (料金のカード・注記・入稿仕様・条件・基準・返金・歓迎事項・流れ)', async () => {
    const { container } = await renderPage();
    const text = plain(container);
    const texts = [
      c.lead,
      c.audience,
      c.plansLead,
      c.priceNote,
      c.terms,
      `${c.bannerTermsLabel}${locale === 'en' ? ' ' : ''}${c.bannerTerms}`,
      c.standardsIntro,
      ...c.standards,
      c.standardsNote,
      c.refund,
      c.welcome,
      c.renewal,
      c.renewalAnnual,
      c.annual.focal,
      c.annual.focalSub,
      c.annual.body,
      ...c.flow,
      ...c.plans.flatMap((p) => [p.focal, p.focalSub, p.body]),
      ...c.specs.map((s) => (s.body ? `${s.label}: ${s.body}` : s.label)),
    ];
    for (const t of texts) expect(text).toContain(t);
  });

  it('料金のカード: 大きい数字は定数の金額', async () => {
    const { container } = await renderPage();
    const plans = container.querySelector<HTMLElement>('section[aria-labelledby="plans"]');
    if (!plans) throw new Error('plans section');
    for (const p of c.plans) {
      const card = within(plans).getByRole('heading', { level: 3, name: p.name }).closest('li');
      if (!card) throw new Error(p.id);
      expect(plain(card)).toContain(SPONSOR_PLANS[p.id].priceYen.toLocaleString('en-US'));
    }
    // 年間プランのカードも料金の節の中 (定数の金額)。
    const annual = within(plans).getByRole('heading', { level: 3, name: c.annual.name }).parentElement;
    if (!annual) throw new Error('annual');
    expect(plain(annual)).toContain(SPONSOR_ANNUAL_PLAN.priceYen.toLocaleString('en-US'));
  });

  it('問い合わせのボタン: LINE・Discord・X だけ (頭と流れの後の 2 か所・LINE が先頭)・フッターと同じ URL と rel・名前は見えている文字', async () => {
    const { container } = await renderPage();
    const line = screen.getAllByRole('link', { name: c.contactLine });
    const discord = screen.getAllByRole('link', { name: c.contactDiscord });
    const x = screen.getAllByRole('link', { name: c.contactX });
    expect(line).toHaveLength(2);
    expect(discord).toHaveLength(2);
    expect(x).toHaveLength(2);
    // どちらの場所でも LINE が先頭 (日本の企業・お店の担当者がいちばん使い慣れた窓口)。
    for (const [i, first] of line.entries()) {
      const row = Array.from(first.parentElement!.querySelectorAll('a'));
      expect(row).toEqual([first, discord[i], x[i]]);
    }
    for (const [links, href] of [
      [line, OPENPAY_LINE_URL],
      [discord, OPENPAY_DISCORD_URL],
      [x, OPENPAY_X_URL],
    ] as const) {
      for (const link of links) {
        expect(link).toHaveAttribute('href', href);
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      }
    }
    // 外のリンクは LINE・Discord・X だけ (フォーム・メールアドレスを出さない)。
    const external = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').filter((href) => !href.startsWith('/'));
    expect([...new Set(external)].sort()).toEqual([OPENPAY_LINE_URL, OPENPAY_DISCORD_URL, OPENPAY_X_URL].sort());
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
    // 流れの節の中にもボタンがある (① の行き先)。
    const flow = container.querySelector<HTMLElement>('section[aria-labelledby="flow"]');
    if (!flow) throw new Error('flow section');
    expect(within(flow).getByRole('link', { name: c.contactLine })).toBeInTheDocument();
    expect(within(flow).getByRole('link', { name: c.contactDiscord })).toBeInTheDocument();
  });

  it('掲載イメージ: 「サンプル」と書いた枠だけ (協賛企業は同じ大きさの枠を最大の社数・バナーは横 4：縦 1)・画像を使わない', async () => {
    const { container } = await renderPage();
    const samples = container.querySelector<HTMLElement>('section[aria-labelledby="samples"]');
    if (!samples) throw new Error('samples section');
    const logos = samples.querySelectorAll<HTMLElement>('[data-sample="sponsor"]');
    expect(logos).toHaveLength(SPONSOR_PLANS.sponsor.maxCompanies);
    for (const logo of logos) {
      expect(within(logo).getByText(c.sampleLabel)).toBeInTheDocument();
      expect(logo.className).toBe(logos[0].className);
    }
    const banner = samples.querySelector<HTMLElement>('[data-sample="banner"]');
    if (!banner) throw new Error('banner sample');
    expect(within(banner).getByText(c.sampleLabel)).toBeInTheDocument();
    expect(banner.style.aspectRatio).toBe(`${SPONSOR_BANNER_SPEC.width} / ${SPONSOR_BANNER_SPEC.height}`);
    expect(samples.querySelector('img, svg, picture')).toBeNull();
  });

  it('可視テキストを含まない aria-label を付けない (掟 8)', async () => {
    const { container } = await renderPage();
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
  });

  it('metadata は canonical /{locale}/sponsors', async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
    expect(meta.title).toBe(c.metaTitle);
    expect(meta.alternates?.canonical).toBe(`/${locale}/sponsors`);
  });
});

describe('/sponsors は sitemap に ja / en で載る (検索で見つけられるように)', () => {
  it.each(['ja', 'en'] as const)('%s', (locale) => {
    expect(sitemap().map((entry) => entry.url)).toContain(`https://open-pay.jp/${locale}/sponsors`);
  });
});
