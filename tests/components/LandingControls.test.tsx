// トップの節のボタン・文字リンク・注・大きい数字が、役割ごとに 1 つの型 (components/LandingControls.ts) を使っていることを固定する。
// 節ごとに色・角・高さを書き分けると、強さの順 (ヒーローの主ボタン > 節の主ボタン > 副ボタン > 文字リンク) が崩れる
// (plans/lp-polish-2026-11.md P2: 主ボタンが 5 通り・AI の節の主ボタンがヒーローより強かった)。
// 見ているのは「どの入口がどの型か」で、型の中の class の文字列は固定しない (型を直すときにこのテストは直さなくてよい)。
// P3 で、カード・押せるカード・アイコンの箱・カードの小見出し・節の見出しの大きさ・白い帯の空き・動きの条件 (motion-safe:) を足した。

import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { cloneElement, isValidElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import { guideNavFor } from '@/lib/guideNav';
import { HOSTED_PRODUCT_CATEGORIES } from '@/lib/x402/storeMeta';
import { LandingAiAgents } from '@/components/LandingAiAgents';
import { LandingBenefits } from '@/components/LandingBenefits';
import { LandingCashComparison } from '@/components/LandingCashComparison';
import { LandingEntryPoints } from '@/components/LandingEntryPoints';
import { LandingFaq } from '@/components/LandingFaq';
import { LandingFeatures } from '@/components/LandingFeatures';
import { LandingHero } from '@/components/LandingHero';
import { LandingHowItWorks } from '@/components/LandingHowItWorks';
import { LandingMobileOrder } from '@/components/LandingMobileOrder';
import { LandingOrderLink } from '@/components/LandingOrderLink';
import { LandingBand } from '@/components/LandingSectionHeader';
import { LandingSellables } from '@/components/LandingSellables';
import { LandingSupport } from '@/components/LandingSupport';
import { LandingTrust } from '@/components/LandingTrust';
import { LandingUseCases } from '@/components/LandingUseCases';
import { LandingWhyStablecoin } from '@/components/LandingWhyStablecoin';
import {
  LANDING_BAND_SPACE,
  LANDING_CARD,
  LANDING_CARD_TITLE,
  LANDING_FIGURE,
  LANDING_ICON_BOX,
  LANDING_LINK_ARROW,
  LANDING_LINK_CARD,
  LANDING_NOTE,
  LANDING_NOTE_CENTERED,
  LANDING_PRIMARY,
  LANDING_SECONDARY,
  LANDING_SECTION_TITLE,
  LANDING_TEXT_LINK,
} from '@/components/LandingControls';

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async (namespace: 'Landing' | 'StoreCatalog') => createTranslator({ locale: 'ja', messages: ja, namespace }),
}));
// 販売の節と AI ストアへの入口は flag が ON のときだけ描く (本番は ON)。
// 特長の節のチェーンのロゴ (lib/chains) は env の RPC と isMainnet を読むので、ほかの値は実物のまま。
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableCreatorStoreUi: true, enableX402Facilitator: true } };
});
// 試算 (client・next-intl の provider が要る) は別のテストが見る。ここでは比較表の脚注とボタンだけを見る。
vi.mock('@/components/SavingsSimulator', () => ({ SavingsSimulator: () => null }));
// 締めの節の中の応援カードは async の子部品 (jsdom の描画では待てない) なので、締めの節からは外して、カードは単独で描く。
vi.mock('@/components/LandingSupportCard', () => ({ LandingSupportCard: () => null }));

const L = ja.Landing;

/** 型の class を全部持っている (置き場所の class を足していてもよい)。 */
function expectType(el: HTMLElement, type: string) {
  const have = new Set(el.className.split(/\s+/));
  expect(type.split(/\s+/).filter((token) => !have.has(token))).toEqual([]);
}

const link = (root: HTMLElement, name: string) => within(root).getByRole('link', { name });

/** 描いた要素が、幅を広げる class を持たない (型に足して全幅に戻すと、ヒーローの主ボタンより大きく見える)。 */
function expectNotFullWidth(el: HTMLElement) {
  expect(el.className.split(/\s+/).filter((token) => /(^|:)w-full$/.test(token))).toEqual([]);
}

describe('トップの節の入口は、役割ごとに 1 つの型を使う', () => {
  it('節の主ボタン: 紺 (販売・AI)・緑 (モバイルオーダー)・濃い面の上は白 (締め)。応援カードの飾りのボタンも紺', async () => {
    const sell = render(await LandingSellables()).container;
    expectType(link(sell, L.sellablesCtaSell), LANDING_PRIMARY.brand);
    const ai = render(await LandingAiAgents()).container;
    expectType(link(ai, L.aiEraCtaAgent), LANDING_PRIMARY.brand);
    const mobileOrder = render(await LandingMobileOrder()).container;
    expectType(link(mobileOrder, L.mobileOrderBannerCta), LANDING_PRIMARY.shop);
    const trust = render(await LandingTrust()).container;
    expectType(link(trust, L.closingCtaStart), LANDING_PRIMARY.onDark);
    const { LandingSupportCard } = await vi.importActual<typeof import('@/components/LandingSupportCard')>('@/components/LandingSupportCard');
    const card = render(await LandingSupportCard()).container;
    expectType(within(card).getByText(L.supportProfileCta), LANDING_PRIMARY.brand);
    // 今まで全幅だった主ボタン (AI・モバイルオーダー・締め・応援カード) は、型の外から全幅を足していない。
    for (const el of [
      link(ai, L.aiEraCtaAgent),
      link(mobileOrder, L.mobileOrderBannerCta),
      link(trust, L.closingCtaStart),
      within(card).getByText(L.supportProfileCta),
    ]) {
      expectNotFullWidth(el);
    }
  });

  it('動きを減らす設定 (prefers-reduced-motion: reduce) のときは、型の動き (押したときの縮み・矢印の移動) を付けない', () => {
    const types = [...Object.values(LANDING_PRIMARY), ...Object.values(LANDING_SECONDARY), ...Object.values(LANDING_TEXT_LINK), LANDING_LINK_ARROW];
    const moving = types.flatMap((type) => type.split(/\s+/)).filter((token) => /(^|:)-?(scale|translate|rotate)-/.test(token));
    // 動きの class がある (このテストが空振りしない) こと。
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.filter((token) => !token.startsWith('motion-safe:'))).toEqual([]);
  });

  it('副ボタン: 白地に枠。濃い面の上は枠だけ', async () => {
    const sell = render(await LandingSellables()).container;
    expectType(link(sell, L.sellablesCtaGuide), LANDING_SECONDARY.brand);
    const ai = render(await LandingAiAgents()).container;
    for (const name of [L.aiEraCtaStore, L.aiEraCtaPay, L.aiEraCtaSell]) expectType(link(ai, name), LANDING_SECONDARY.brand);
    const mobileOrder = render(await LandingMobileOrder()).container;
    expectType(link(mobileOrder, L.mobileOrderBannerLearnMore), LANDING_SECONDARY.shop);
    const cash = render(await LandingCashComparison()).container;
    expectType(link(cash, L.cashStoreKitCta), LANDING_SECONDARY.brand);
    const trust = render(await LandingTrust()).container;
    expectType(within(trust).getByRole('link', { name: new RegExp(L.trustGithubLabel.replace(/[()]/g, '\\$&')) }), LANDING_SECONDARY.onDark);
  });

  it('矢印つきの文字リンク: 紺 (料金)・緑 (注文リンク・ガイド)', async () => {
    const pricing = render(await LandingSupport()).container;
    expectType(link(pricing, L.supportFeeDetailsLink), LANDING_TEXT_LINK.brand);
    const orderLink = render(await LandingOrderLink()).container;
    expectType(link(orderLink, L.orderLinkStripLink), LANDING_TEXT_LINK.shop);
    const guides = render(await LandingEntryPoints()).container;
    expectType(link(guides, L.entryAllGuides), LANDING_TEXT_LINK.shop);
  });

  it('ヒーローの主ボタンは節の型を使わない (ページで 1 つだけの、いちばん大きいボタン)', async () => {
    const hero = render(await LandingHero()).container;
    const cta = link(hero, L.heroCta);
    for (const type of Object.values(LANDING_PRIMARY)) expect(cta.className).not.toBe(type);
    // 節の主ボタン (高さ 44px・角 xl・14px) より大きい: 高さ 48px・角 2xl・16px の太字。
    expect(cta.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-12', 'rounded-2xl', 'text-base', 'font-bold']));
    for (const type of Object.values(LANDING_PRIMARY)) {
      expect(type.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-11', 'rounded-xl', 'text-sm', 'font-semibold']));
      // 全幅にしない (ヒーローの主ボタンより大きく見せない)。
      expect(type.split(/\s+/)).not.toContain('w-full');
    }
  });

  it('小さな注: 比較表・料金・AI の節の注は同じ型 (文は消さない)', async () => {
    const cash = render(await LandingCashComparison()).container;
    expectType(within(cash).getByText(L.cashTableFootnote), LANDING_NOTE);
    const pricing = render(await LandingSupport()).container;
    expectType(within(pricing).getByText(L.supportFeeNote), LANDING_NOTE_CENTERED);
    const ai = render(await LandingAiAgents()).container;
    expectType(within(ai).getByText(L.aiEraAgentNote), LANDING_NOTE_CENTERED);
    expectType(within(ai).getByText(L.aiEraSellNote), LANDING_NOTE_CENTERED);
  });

  it('大きい数字: 導入メリットと比較表の「0円〜」は同じ太さ・行の高さ・字間・数字の幅。色は型に入れない (誰が払うかの意味)', async () => {
    const benefits = render(await LandingBenefits()).container;
    const focals = [...benefits.querySelectorAll<HTMLElement>('[data-focal]')];
    expect(focals).toHaveLength(4);
    for (const focal of focals) expectType(focal, LANDING_FIGURE.base);
    // お店 = 緑・お客様 = 青 のまま。
    expect(focals.map((f) => (f.className.match(/text-(emerald|blue)-600/) ?? [])[1])).toEqual(['emerald', 'emerald', 'emerald', 'blue']);
    const cash = render(await LandingCashComparison()).container;
    expectType(within(cash).getByText(L.cashCellFeeOpenPay), LANDING_FIGURE.cell);
    for (const type of Object.values(LANDING_FIGURE)) expect(type).not.toMatch(/\btext-(emerald|blue|brand|slate)/);
  });
});

// ---- P3: 入れ物 (カード・アイコンの箱・カードの小見出し)・節の強弱・白い帯の空き・動き ----

/** 描いた要素の class (svg は className が文字列でないので属性から読む)。 */
const classTokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/**
 * 型の class を全部持ち、同じ役割の class (family = 角・影・枠・大きさ など) を型の外から足していない。
 * expectType (型の class を持つ) だけだと、置き換えた所に古い角や枠が残っていても通る (CSS ではどちらが勝つかが順で決まる)。
 */
function expectOnly(el: Element | null | undefined, type: string, family: RegExp) {
  expect(el).toBeTruthy();
  const have = classTokens(el!);
  const want = type.split(/\s+/);
  expect(want.filter((token) => !have.includes(token))).toEqual([]);
  expect(have.filter((token) => family.test(token) && !want.includes(token))).toEqual([]);
}
// カードの形を決める class: 角・地の色・影・枠 (ring / border)・focus の輪・位置や大きさの動き。
const CARD_FAMILY = /^(?:[\w-]+:)*(?:rounded|bg-|shadow|ring|border|outline|-?translate-|scale-)/;
// アイコンの箱の形: 大きさ・角・枠。地と字の色は使う側 (誰が払うか・節の色)。
const ICON_BOX_FAMILY = /^(?:[\w-]+:)*(?:h-|w-|size-|rounded|ring)/;
// 字の大きさ。
const SIZE_FAMILY = /^(?:[\w-]+:)*text-(?:xs|sm|base|lg|\d?xl|\[)/;
// 小見出しの大きさ・太さ・字の色。
const TITLE_FAMILY = /^(?:[\w-]+:)*(?:text-(?:xs|sm|base|lg|\d?xl|\[)|font-(?:normal|medium|semibold|bold|extrabold)|text-slate-)/;
// 位置・大きさ・向きの動き (hover・押下・開閉で付くものを含む)。
const MOTION = /(^|:)-?(scale|translate|rotate)-/;

/**
 * Server Component の木の中の async の子部品 (使い方の中のガイドの入口・締めの中の応援カード) を先に待って展開する
 * (jsdom の描画は async の部品を待てない)。children だけをたどる。
 */
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
const renderServer = async (tree: Promise<ReactNode>) => render(await resolveServer(await tree)).container;

/** トップ (app/[locale]/page.tsx) に並ぶ節。接続後の帯 (LandingYourOpenPay) と白い帯 (LandingBand) は下の別の検査で見る。 */
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
const PAGE_SOURCE = readFileSync(join(process.cwd(), 'app/[locale]/page.tsx'), 'utf8');

const GUIDE_SLUGS = ['start', 'qr', 'shop', 'store'] as const;
const WHY_TITLES = [L.whyItem1Title, L.whyItem3Title];
const whyCard = (root: HTMLElement, title: string) => within(root).getByText(title).closest('div');

describe('トップのカード・アイコンの箱・カードの小見出しは、役割ごとに 1 つの型を使う (P3)', () => {
  it('静的なカード: 導入メリット・特長・用途・3 ステップ・動画の枠・FAQ・なぜ今・注文リンク・見本の外枠は同じ形 (古い角・枠・影を残さない)', async () => {
    const benefits = render(await LandingBenefits()).container;
    const features = render(await LandingFeatures()).container;
    const useCases = render(await LandingUseCases()).container;
    const how = await renderServer(LandingHowItWorks());
    const faq = render(await LandingFaq()).container;
    const why = render(await LandingWhyStablecoin()).container;
    const orderLink = render(await LandingOrderLink()).container;
    const sell = render(await LandingSellables()).container;
    const cards = [
      ...benefits.querySelectorAll('ul > li'),
      ...features.querySelectorAll('ul > li'),
      ...useCases.querySelectorAll('ul > li'),
      how.querySelector('article'),
      ...[...how.querySelectorAll('video')].map((video) => video.parentElement),
      faq.querySelector('ul'),
      ...WHY_TITLES.map((title) => whyCard(why, title)),
      within(orderLink).getByRole('heading', { name: L.orderLinkStripTitle }).closest('section')?.firstElementChild,
      within(sell).getByRole('heading', { level: 3, name: L.profileDemoTitle }).parentElement?.parentElement,
    ];
    expect(cards).toHaveLength(4 + 3 + 4 + 1 + 3 + 1 + 2 + 1 + 1);
    for (const card of cards) expectOnly(card, LANDING_CARD, CARD_FAMILY);
  });

  it('押せるカード: ガイドの入口 4 枚 (緑)・応援カード (濃い面の上)。hover で浮かせない・focus の輪を持つ', async () => {
    const guides = render(await LandingEntryPoints()).container;
    for (const slug of GUIDE_SLUGS) expectOnly(guides.querySelector(`a[href="/ja/guide/${slug}"]`), LANDING_LINK_CARD.shop, CARD_FAMILY);
    const { LandingSupportCard } = await vi.importActual<typeof import('@/components/LandingSupportCard')>('@/components/LandingSupportCard');
    const support = render(await LandingSupportCard()).container;
    expectOnly(support.querySelector('a[href*="openpay_jp"]'), LANDING_LINK_CARD.onDark, CARD_FAMILY);
    // 明るい地の上のカードは、静的なカードと同じ形 (淡い枠を含む)。濃い面の上は枠なし (白い面と地の間に灰色の縁を出さない)。
    expect(LANDING_LINK_CARD.shop.split(/\s+/)).toEqual(expect.arrayContaining(LANDING_CARD.split(/\s+/)));
    expect(LANDING_LINK_CARD.onDark.split(/\s+/).filter((token) => /^ring/.test(token))).toEqual([]);
    const face = LANDING_CARD.split(/\s+/).filter((token) => !/^ring/.test(token));
    for (const type of Object.values(LANDING_LINK_CARD)) {
      // 角・白・影は静的なカードと同じ。位置や大きさは動かさない。focus の輪は節のボタンと同じ 2px・外側 2px。
      expect(type.split(/\s+/)).toEqual(expect.arrayContaining([...face, 'focus-visible:outline-2', 'focus-visible:outline-offset-2']));
      expect(type.split(/\s+/).filter((token) => MOTION.test(token))).toEqual([]);
    }
  });

  it('アイコンの箱: 導入メリット・なぜ今・ガイドの入口・注文リンクは同じ 36px の箱 (地と字の色は使う側)', async () => {
    const benefits = render(await LandingBenefits()).container;
    const why = render(await LandingWhyStablecoin()).container;
    const guides = render(await LandingEntryPoints()).container;
    const orderLink = render(await LandingOrderLink()).container;
    const boxes = [
      ...[...benefits.querySelectorAll('ul > li')].map((li) => li.firstElementChild),
      ...WHY_TITLES.map((title) => whyCard(why, title)?.querySelector('svg')?.parentElement),
      ...GUIDE_SLUGS.map((slug) => guides.querySelector(`a[href="/ja/guide/${slug}"]`)?.firstElementChild),
      orderLink.querySelector('svg')?.parentElement,
    ];
    expect(boxes).toHaveLength(4 + 2 + 4 + 1);
    for (const box of boxes) expectOnly(box, LANDING_ICON_BOX, ICON_BOX_FAMILY);
  });

  it('注文リンク: スマホのリンクの字下げは、アイコンの箱の幅 + 間 (箱の大きさを変えたら字下げも合わせる)', async () => {
    const orderLink = render(await LandingOrderLink()).container;
    const box = orderLink.querySelector('svg')!.parentElement!;
    const rem = (tokens: string[], re: RegExp) => Number(tokens.find((token) => re.test(token))!.match(/-(\d+(?:\.\d+)?)$/)![1]) / 4;
    const indent = rem(classTokens(box), /^w-\d/) + rem(classTokens(box.parentElement!), /^gap-\d/);
    expect(classTokens(within(orderLink).getByRole('link', { name: L.orderLinkStripLink }))).toContain(`ml-[${indent}rem]`);
  });

  it('カードの小見出し: 導入メリット・特長・用途・なぜ今・ガイドの入口は同じ大きさ・太さ・色 (タグと見出しの階層はそのまま)', async () => {
    const benefits = render(await LandingBenefits()).container;
    const features = render(await LandingFeatures()).container;
    const useCases = render(await LandingUseCases()).container;
    const why = render(await LandingWhyStablecoin()).container;
    const guides = render(await LandingEntryPoints()).container;
    const nav = guideNavFor('ja');
    const whyTitles = WHY_TITLES.map((title) => within(why).getByText(title));
    const guideTitles = GUIDE_SLUGS.map((slug) => within(guides).getByText(nav.items[slug].label));
    // なぜ今の題・ガイドの入口の題は span のまま (見出しを増やさない)。
    for (const el of [...whyTitles, ...guideTitles]) expect(el.tagName).toBe('SPAN');
    const titles = [
      ...benefits.querySelectorAll('h3'),
      ...features.querySelectorAll('h3'),
      ...useCases.querySelectorAll('h3'),
      ...whyTitles,
      ...guideTitles,
    ];
    expect(titles).toHaveLength(4 + 3 + 4 + 2 + 4);
    for (const title of titles) expectOnly(title, LANDING_CARD_TITLE, TITLE_FAMILY);
  });

  it('販売の節のカテゴリの印: 独自の影をやめて、カードと同じ影と淡い枠 (形は丸いまま)', async () => {
    const sell = render(await LandingSellables()).container;
    const chips = [...(within(sell).getByRole('heading', { level: 2 }).parentElement?.nextElementSibling?.children ?? [])];
    expect(chips).toHaveLength(HOSTED_PRODUCT_CATEGORIES.length);
    const cardSurface = LANDING_CARD.split(/\s+/).filter((token) => /^(shadow|ring)/.test(token)).join(' ');
    for (const chip of chips) {
      expectOnly(chip, cardSurface, /^(?:[\w-]+:)*(?:shadow|ring)/);
      expect(classTokens(chip)).toContain('rounded-full');
    }
  });
});

describe('節の強弱と白い帯の空き (P3)', () => {
  it('補足の節 (なぜ今・よくある質問) は見出しを 1 段小さく、見出しから中身までを狭く。ほかの節はふつうの大きさ', async () => {
    for (const [section, title] of [
      [LandingWhyStablecoin, L.whyStablecoinTitle],
      [LandingFaq, L.faqTitle],
    ] as const) {
      const root = render(await section()).container;
      // 見出しの階層 (h2) は変えない。
      const h2 = within(root).getByRole('heading', { level: 2, name: title });
      expectOnly(h2, LANDING_SECTION_TITLE.sm, SIZE_FAMILY);
      // 見出しの塊 (章ラベル + 見出し + 副題) のすぐ後の中身。
      const body = h2.parentElement!.nextElementSibling!;
      expect(classTokens(body).filter((token) => /^(?:[\w-]+:)*mt-/.test(token))).toEqual(['mt-6']);
    }
    for (const section of [
      LandingBenefits,
      LandingCashComparison,
      LandingSellables,
      LandingAiAgents,
      LandingFeatures,
      LandingUseCases,
      LandingHowItWorks,
      LandingSupport,
    ]) {
      const root = await renderServer(section());
      expectOnly(root.querySelector('h2'), LANDING_SECTION_TITLE.md, SIZE_FAMILY);
    }
  });

  it('白い帯: 帯の外 (上の節 → 縁)・帯の中 (縁 → 節)・帯の後ろ (縁 → 次の節) の空きが、スマホも sm 以上も同じ', () => {
    const band = render(
      <LandingBand>
        <section />
      </LandingBand>,
    ).container.firstElementChild as HTMLElement;
    expectType(band, LANDING_BAND_SPACE);
    const tokens = classTokens(band);
    const values = (re: RegExp) => tokens.filter((token) => re.test(token)).map((token) => token.match(/-(\d+)$/)![1]);
    for (const bp of ['', 'sm:']) {
      const outside = values(new RegExp(`^${bp}mt-\\d+$`));
      expect(outside).toHaveLength(1);
      expect(values(new RegExp(`^${bp}py-\\d+$`))).toEqual(outside);
      expect(values(new RegExp(`^${bp}\\[&\\+section\\]:mt-\\d+$`))).toEqual(outside);
    }
    // 帯の中の最初の節は上の余白を持たない (帯の中の空きでそろえる)。
    expect(tokens).toContain('[&>*:first-child]:mt-0');
  });

  it('白い帯のすぐ後ろの節は section (帯の側の「直後の節」の指定が当たる)。販売の節が出ないとき (Store の flag) に続く AI の節も', async () => {
    const followers = [...PAGE_SOURCE.matchAll(/<\/LandingBand>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)*<(\w+)/g)].map((m) => m[1]);
    expect(followers).toHaveLength(PAGE_SOURCE.match(/<LandingBand>/g)!.length);
    for (const name of [...followers, 'LandingAiAgents']) {
      expect(SECTIONS[name]).toBeDefined();
      const root = await renderServer(SECTIONS[name]());
      expect(root.firstElementChild?.tagName).toBe('SECTION');
    }
  });
});

describe('トップの中の動き (P3)', () => {
  it('拡大・縮小・移動・回転は、全部「動きを減らす設定でないときだけ」(motion-safe:)。描いた全部の節と子部品で見る', async () => {
    // トップに並ぶ節は、全部ここで描く (新しい節を足したら SECTIONS にも足す)。
    const used = [...new Set([...PAGE_SOURCE.matchAll(/<(Landing\w+)/g)].map((m) => m[1]))];
    expect(used.filter((name) => !(name in SECTIONS) && name !== 'LandingYourOpenPay' && name !== 'LandingBand')).toEqual([]);
    const moving: string[] = [];
    const collect = (root: Element) => {
      for (const el of root.querySelectorAll('[class]')) moving.push(...classTokens(el).filter((token) => MOTION.test(token)));
    };
    for (const section of Object.values(SECTIONS)) collect(await renderServer(section()));
    // このファイルで mock で外した子部品 (締めの応援カード・比較表の試算) は単独で描く。
    const { LandingSupportCard } = await vi.importActual<typeof import('@/components/LandingSupportCard')>('@/components/LandingSupportCard');
    collect(render(await LandingSupportCard()).container);
    const { SavingsSimulator } = await vi.importActual<typeof import('@/components/SavingsSimulator')>('@/components/SavingsSimulator');
    collect(
      render(
        <NextIntlClientProvider locale="ja" messages={ja}>
          <SavingsSimulator />
        </NextIntlClientProvider>,
      ).container,
    );
    // 動きの class がある (このテストが空振りしない): ヒーローの縮みと矢印・モバイルオーダーの画像・ガイドの矢印・FAQ の矢印・節のボタン。
    expect(moving.length).toBeGreaterThan(10);
    expect([...new Set(moving.filter((token) => !token.startsWith('motion-safe:')))]).toEqual([]);
  });

  it('接続後の帯 (wagmi と SIWE が要る client 部品) の動きも motion-safe: だけ (source の class の文字列で見る)', () => {
    const tokens = ['components/LandingYourOpenPay.tsx', 'components/LandingYourOpenPayClient.tsx'].flatMap(
      (file) => readFileSync(join(process.cwd(), file), 'utf8').match(/[\w:[\]-]*-?(?:scale|translate|rotate)-[\w.[\]/-]+/g) ?? [],
    );
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((token) => !token.startsWith('motion-safe:'))).toEqual([]);
  });
});
