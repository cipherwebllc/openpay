// 文節の区切りを入れる components/Phrased.tsx と、トップのどこに当てているかのテスト。
//   - ja のときだけ <span class="phrased">塊<wbr>塊…</span> を返す。en・塊が 1 つの文は文字列のまま (DOM は今までと同じ)
//   - 文字は 1 字も変えない (textContent・見出しの名前)
//   - 当てる範囲: 見出し・リード・カードの題・手順・FAQ の質問・節の下の注・締め。当てない範囲: 比較表・ボタン・リンク・
//     ピル・章ラベル・大きい数字・リンク入りの文 (t.rich)・client の中の文字・スマホで 2 列になるカード (導入メリット・なぜ今) の本文

import { createTranslator } from 'next-intl';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { render, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';
import { phrasesJa } from '@/lib/phrase/phrases';
import { LANDING_FAQ } from '@/lib/landingFaq';
import { pricingContentFor } from '@/lib/pricing';
import { phrased } from '@/components/Phrased';
import { LandingAiAgents } from '@/components/LandingAiAgents';
import { LandingBenefits } from '@/components/LandingBenefits';
import { LandingCashComparison } from '@/components/LandingCashComparison';
import { LandingFaq } from '@/components/LandingFaq';
import { LandingFeatures } from '@/components/LandingFeatures';
import { LandingHero } from '@/components/LandingHero';
import { LandingHowItWorks } from '@/components/LandingHowItWorks';
import { LandingMobileOrder } from '@/components/LandingMobileOrder';
import { LandingOrderLink } from '@/components/LandingOrderLink';
import { LandingSellables } from '@/components/LandingSellables';
import { LandingSupport } from '@/components/LandingSupport';
import { LandingTrust } from '@/components/LandingTrust';
import { LandingUseCases } from '@/components/LandingUseCases';
import { LandingWhyStablecoin } from '@/components/LandingWhyStablecoin';

const context = vi.hoisted(() => ({ locale: 'ja' as 'ja' | 'en' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => context.locale,
  getTranslations: async (namespace: 'Landing' | 'StoreCatalog') =>
    createTranslator({ locale: context.locale, messages: context.locale === 'ja' ? ja : en, namespace }),
}));
// 販売の節と AI ストアへの入口は flag が ON のときだけ描く (本番は ON)。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStoreUi: true, enableX402Facilitator: true } };
});
// 試算 (client・next-intl の provider が要る) は区切りを当てない所で、別のテストが見る。
vi.mock('@/components/SavingsSimulator', () => ({ SavingsSimulator: () => null }));

beforeEach(() => {
  context.locale = 'ja';
});

const L = ja.Landing as Record<string, string>;

/** Server Component の木の中の async の子部品 (ガイドの入口・締めの応援カード) を先に待って展開する (jsdom の描画は待てない)。 */
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    return resolveServer(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  }
  if (node.props.children === undefined) return node;
  const children = await resolveServer(node.props.children);
  return cloneElement(node, undefined, ...(Array.isArray(children) ? children : [children]));
}

/** トップ (app/[locale]/page.tsx) に並ぶ節。接続後の帯は client の中の文字だけなので、区切りを当てていない。 */
const SECTIONS: Record<string, () => Promise<ReactNode>> = {
  LandingHero,
  LandingMobileOrder,
  LandingOrderLink,
  LandingBenefits,
  LandingCashComparison,
  LandingWhyStablecoin,
  LandingSellables,
  LandingAiAgents,
  LandingFeatures,
  LandingUseCases,
  LandingHowItWorks,
  LandingSupport,
  LandingFaq,
  LandingTrust,
};

async function renderSections(): Promise<Record<string, HTMLElement>> {
  const out: Record<string, HTMLElement> = {};
  for (const [name, section] of Object.entries(SECTIONS)) out[name] = render(await resolveServer(await section())).container;
  return out;
}

// 区切りを当てる文 (節ごと)。ここに無い文に区切りが入ったら、下の「当てた文はこの一覧だけ」が落ちる。
const pricing = pricingContentFor('ja');
const APPLIED: Record<string, readonly string[]> = {
  LandingHero: [L.heroLeadline, L.heroBody],
  LandingMobileOrder: [L.mobileOrderBannerTitle, L.mobileOrderBannerLead],
  LandingOrderLink: [L.orderLinkStripTitle, L.orderLinkStripBody],
  // 導入メリット: 見出し・リード・4 枚の題。本文は当てない (スマホで 2 列の欄が、塊「メール・本人確認は」より狭い)。
  LandingBenefits: [L.payoutStatementTitle, L.payoutStatementBody, L.benefitsFeeTitle, L.benefitsCostTitle, L.benefitsSettlementTitle, L.benefitsNoSignupTitle],
  // 比較: 見出し・リード・表の下の注。表の中は当てない。
  LandingCashComparison: [L.cashTitle, L.cashSubtitle, L.cashTableFootnote],
  // なぜ今: 見出し・リード・2 枚の題。本文は当てない (文節で折れる Chromium で、幅 375px の最後の行が「まま。」だけになる)。
  LandingWhyStablecoin: [L.whyStablecoinTitle, L.whyStablecoinSubtitle, L.whyItem1Title, L.whyItem3Title],
  LandingSellables: [L.sellablesTitle, L.sellablesSubtitle, L.sellablesBody],
  LandingAiAgents: [L.aiEraTitle, L.aiEraBody, L.aiEraAgentNote, L.aiEraSellNote],
  // 特長: 見出し・リード・3 枚の題。本文はリンク入り (t.rich) なので当てない。
  LandingFeatures: [L.featuresTitle, L.featuresSubtitle, L.featuresGaslessTitle, L.featuresMultichainTitle, L.featuresNoncustodyTitle],
  LandingUseCases: [
    L.useCasesTitle,
    L.useCasesSubtitle,
    ...['1', '8', '2', '5'].flatMap((id) => [L[`useCase${id}Title`], L[`useCase${id}Body`]]),
  ],
  LandingHowItWorks: [L.howItWorksTitle, L.howItWorksSubtitle, L.howItWorksMerchantTitle, L.howItWorksMerchantStep1, L.howItWorksMerchantStep2, L.howItWorksMerchantStep3],
  LandingSupport: [pricing.summaryTitle, pricing.lead, L.supportFeeNote],
  // FAQ: 見出しと質問。答えはリンク入り (t.rich) なので当てない。
  LandingFaq: [L.faqTitle, ...LANDING_FAQ.map(({ q }) => L[q])],
  // 締め: 題・本文・オープン技術の本文・応援の案内 (応援カードは締めの子部品)。
  LandingTrust: [L.closingTitle, L.closingBody, L.trustBody, L.supportTipRequest],
};

describe('phrased(): 文節の区切りを入れる', () => {
  it('ja: 塊の間に <wbr> を入れた span 1 つを返す。文字は変えない', () => {
    const { container } = render(<p>{phrased(L.heroLeadline, 'ja')}</p>);
    const p = container.firstElementChild!;
    expect(p.childNodes).toHaveLength(1);
    const span = p.firstElementChild!;
    expect(span.tagName).toBe('SPAN');
    expect(span.getAttribute('class')).toBe('phrased');
    // 塊と <wbr> が交互に並ぶ (塊 3 つ・<wbr> 2 つ)。
    expect([...span.childNodes].map((node) => (node.nodeType === Node.TEXT_NODE ? node.textContent : node.nodeName))).toEqual([
      'お店の',
      'WBR',
      'JPYC決済を、',
      'WBR',
      '利用料0円から。',
    ]);
    expect(p.textContent).toBe(L.heroLeadline);
  });

  it('ja でない locale は、文字列をそのまま返す (日本語の文を渡しても包まない)', () => {
    expect(phrased('JPYC payments for your shop, from ¥0 in fees.', 'en')).toBe('JPYC payments for your shop, from ¥0 in fees.');
    expect(phrased(L.heroLeadline, 'en')).toBe(L.heroLeadline);
  });

  it('塊が 1 つだけの文・空の文は、span を足さずに文字列をそのまま返す', () => {
    expect(phrasesJa(L.mobileOrderBannerTitle)).toHaveLength(1);
    expect(phrased(L.mobileOrderBannerTitle, 'ja')).toBe(L.mobileOrderBannerTitle);
    expect(phrased('', 'ja')).toBe('');
    expect(phrased('OpenPay', 'ja')).toBe('OpenPay');
  });
});

describe('jsdom の土台 (tests/setup.ts)', () => {
  it('区切りの <wbr> (.phrased の中) にだけ、ブラウザの既定と同じ display: inline を教える。ほかの <wbr> は jsdom のまま', () => {
    const { container } = render(
      <div>
        <p>{phrased(L.heroLeadline, 'ja')}</p>
        <h3>
          長い語
          <wbr />
          の途中
        </h3>
      </div>,
    );
    expect(getComputedStyle(container.querySelector('.phrased wbr')!).display).toBe('inline');
    expect(getComputedStyle(container.querySelector('h3 wbr')!).display).toBe('');
  });
});

describe('トップの ja: 区切りを当てる範囲', () => {
  it('当てた文はこの一覧だけ (節ごと)。塊が 2 つ以上の文は全部 span に包まれ、ほかの文は包まれない', async () => {
    const sections = await renderSections();
    expect(Object.keys(sections).sort()).toEqual(Object.keys(APPLIED).sort());
    let total = 0;
    for (const [name, container] of Object.entries(sections)) {
      const expected = APPLIED[name].filter((text) => phrasesJa(text).length > 1);
      const actual = [...container.querySelectorAll('.phrased')].map((span) => span.textContent ?? '');
      expect({ name, phrased: [...actual].sort() }).toEqual({ name, phrased: [...expected].sort() });
      total += actual.length;
    }
    // 区切りが実際に入っている (この検査が空振りしない)。
    expect(total).toBeGreaterThan(50);
  });

  it('文字は 1 字も変えない: 当てた文は、そのまま節の文字 (textContent) に出る。[object Object] を出さない', async () => {
    const sections = await renderSections();
    for (const [name, container] of Object.entries(sections)) {
      const text = container.textContent ?? '';
      expect(text).not.toContain('[object Object]');
      for (const applied of APPLIED[name]) expect({ name, has: text.includes(applied), applied }).toEqual({ name, has: true, applied });
    }
  });

  it('span の形: class は phrased だけ・子は文字と <wbr> だけ・入れ子にしない・<wbr> は span の中だけ', async () => {
    const sections = await renderSections();
    for (const container of Object.values(sections)) {
      for (const span of container.querySelectorAll('.phrased')) {
        expect(span.tagName).toBe('SPAN');
        expect(span.getAttribute('class')).toBe('phrased');
        expect([...span.children].map((child) => child.tagName).filter((tag) => tag !== 'WBR')).toEqual([]);
        // <wbr> の数は塊の数 − 1。空の塊は無い。
        const parts = [...span.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '');
        expect(parts).toEqual(phrasesJa(span.textContent ?? ''));
        expect(span.querySelectorAll('wbr')).toHaveLength(parts.length - 1);
        // 親の中で、区切りの span は 1 つ (flex の親でも、文は 1 つの子のまま)。
        expect([...span.parentElement!.children].filter((child) => child.classList.contains('phrased'))).toHaveLength(1);
      }
      for (const wbr of container.querySelectorAll('wbr')) {
        expect(wbr.parentElement!.getAttribute('class')).toBe('phrased');
        // 読み上げの木から外す (付けないと、Chromium は <wbr> の所に空白を入れて見出しの名前を作る)。
        expect(wbr.getAttribute('aria-hidden')).toBe('true');
      }
    }
  });

  it('当てない所: リンク・ボタン・比較表・大きい数字・FAQ の答え・導入メリットの本文には、区切りを入れない', async () => {
    const sections = await renderSections();
    for (const container of Object.values(sections)) {
      expect(container.querySelectorAll('a .phrased, button .phrased, table .phrased, [data-focal] .phrased, a wbr, button wbr, table wbr')).toHaveLength(0);
    }
    // FAQ の答え (details の中の p) はリンク入りの文。
    const answers = [...sections.LandingFaq.querySelectorAll('details > p')];
    expect(answers).toHaveLength(LANDING_FAQ.length);
    for (const answer of answers) expect(answer.querySelector('.phrased, wbr')).toBeNull();
    // 導入メリットのカード: 題 (h3) には入れ、本文 (最後の p) には入れない。
    const cards = [...sections.LandingBenefits.querySelectorAll('ul > li')];
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      const body = card.lastElementChild!;
      expect(body.tagName).toBe('P');
      expect(body.querySelector('.phrased, wbr')).toBeNull();
    }
    expect(cards.filter((card) => card.querySelector('h3 .phrased'))).toHaveLength(3);
    // なぜ今のカード (スマホで 2 列): 題には入れ、本文 (カードの中の p) には入れない。
    const whyBodies = [...sections.LandingWhyStablecoin.querySelectorAll('.grid-cols-2 > div > p')];
    expect(whyBodies.map((p) => p.textContent)).toEqual([L.whyItem1Body, L.whyItem3Body]);
    for (const body of whyBodies) expect(body.querySelector('.phrased, wbr')).toBeNull();
    // 特長のカードの本文 (リンク入り) にも入れない。
    for (const body of sections.LandingFeatures.querySelectorAll('ul > li > p')) expect(body.querySelector('.phrased, wbr')).toBeNull();
  });

  it('ヒーロー: 見出しと本文の文字は元の文のまま。見出しは名前でも見つかる (<wbr> は名前に入らない)', async () => {
    const hero = render(await LandingHero()).container;
    const h2 = within(hero).getByRole('heading', { level: 2, name: L.heroLeadline });
    expect(h2.textContent).toBe(L.heroLeadline);
    expect(h2.querySelectorAll('wbr')).toHaveLength(2);
    // 見出しの直接の子は、区切りの span 1 つだけ。
    expect([...h2.childNodes].map((node) => node.nodeName)).toEqual(['SPAN']);
    const body = h2.nextElementSibling!;
    expect(body.tagName).toBe('P');
    expect(body.textContent).toBe(L.heroBody);
    expect(body.querySelectorAll('wbr')).toHaveLength(phrasesJa(L.heroBody).length - 1);
  });

  it('区切りを入れた見出しは、どれも元の文の名前で見つかる (節の見出し・カードの題)', async () => {
    const sections = await renderSections();
    let checked = 0;
    for (const container of Object.values(sections)) {
      for (const heading of container.querySelectorAll('h2, h3')) {
        if (!heading.querySelector('.phrased')) continue;
        expect(within(container).getAllByRole('heading', { name: heading.textContent ?? '' })).toContain(heading);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });
});

describe('トップの en: DOM は今までと同じ (区切りを入れない)', () => {
  it('どの節にも span.phrased と <wbr> が無い', async () => {
    context.locale = 'en';
    const sections = await renderSections();
    for (const [name, container] of Object.entries(sections)) {
      expect({ name, phrased: container.querySelectorAll('.phrased').length, wbr: container.querySelectorAll('wbr').length }).toEqual({ name, phrased: 0, wbr: 0 });
    }
    // en を描いている (この検査が空振りしない)。
    expect(sections.LandingHero.querySelector('h2')!.textContent).toBe(en.Landing.heroLeadline);
  });
});
