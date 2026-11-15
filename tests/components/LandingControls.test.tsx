// トップの節のボタン・文字リンク・注・大きい数字が、役割ごとに 1 つの型 (components/LandingControls.ts) を使っていることを固定する。
// 節ごとに色・角・高さを書き分けると、強さの順 (ヒーローの主ボタン > 節の主ボタン > 副ボタン > 文字リンク) が崩れる
// (plans/lp-polish-2026-11.md P2: 主ボタンが 5 通り・AI の節の主ボタンがヒーローより強かった)。
// 見ているのは「どの入口がどの型か」で、型の中の class の文字列は固定しない (型を直すときにこのテストは直さなくてよい)。

import { createTranslator } from 'next-intl';
import { render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ja from '@/messages/ja.json';
import { LandingAiAgents } from '@/components/LandingAiAgents';
import { LandingBenefits } from '@/components/LandingBenefits';
import { LandingCashComparison } from '@/components/LandingCashComparison';
import { LandingEntryPoints } from '@/components/LandingEntryPoints';
import { LandingHero } from '@/components/LandingHero';
import { LandingMobileOrder } from '@/components/LandingMobileOrder';
import { LandingOrderLink } from '@/components/LandingOrderLink';
import { LandingSellables } from '@/components/LandingSellables';
import { LandingSupport } from '@/components/LandingSupport';
import { LandingTrust } from '@/components/LandingTrust';
import {
  LANDING_FIGURE,
  LANDING_LINK_ARROW,
  LANDING_NOTE,
  LANDING_NOTE_CENTERED,
  LANDING_PRIMARY,
  LANDING_SECONDARY,
  LANDING_TEXT_LINK,
} from '@/components/LandingControls';

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getTranslations: async (namespace: 'Landing' | 'StoreCatalog') => createTranslator({ locale: 'ja', messages: ja, namespace }),
}));
// 販売の節と AI ストアへの入口は flag が ON のときだけ描く (本番は ON)。
vi.mock('@/lib/env', () => ({ env: { enableCreatorStoreUi: true, enableX402Facilitator: true } }));
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
