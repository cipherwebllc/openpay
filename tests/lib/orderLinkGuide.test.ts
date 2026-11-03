// /guide/order-link の content (lib/orderLinkGuide.ts) の検査:
// - ja/en の形がそろう
// - 利用料の率と最低額を直書きしない (掟 14・page が DISCLOSED_* 由来の値で埋める)
// - 「」/“” で引いたボタン・画面の名前が、今の画面の文言 (messages) と一致する (画面の文言を変えたらガイドも直す)
// - お店の責任の文は画面 (OrderLinkBuilder.sellerDuty) と同じ

import { describe, expect, it } from 'vitest';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';
import { guideNavFor } from '@/lib/guideNav';
import { orderLinkGuideContentFor, orderLinkGuideMetadata, type OrderLinkGuideContent } from '@/lib/orderLinkGuide';

const MESSAGES = { ja, en } as const;

function allText(c: OrderLinkGuideContent): string[] {
  return [
    c.metaTitle,
    c.metaDescription,
    c.subtitle,
    c.lead,
    c.ctaCreate,
    ...c.forWhoChips,
    ...c.features.flatMap((f) => [f.title, f.body]),
    ...c.steps,
    ...c.paySteps,
    c.feeGasless.focal,
    c.feeGasless.title,
    c.feeGasless.body,
    c.feeStandard.focal,
    c.feeStandard.title,
    c.feeStandard.body,
    c.feeLimit,
    ...c.checks,
    c.sellerDuty,
    ...c.faq.flatMap((f) => [f.q, f.a]),
    c.ctaTitle,
    c.ctaBody,
    c.ctaLabel,
  ];
}

describe('注文リンクのガイド (content)', () => {
  it('ja と en の形がそろう', () => {
    const a = orderLinkGuideContentFor('ja');
    const b = orderLinkGuideContentFor('en');
    expect(a.forWhoChips).toHaveLength(b.forWhoChips.length);
    expect(a.features).toHaveLength(b.features.length);
    expect(a.steps).toHaveLength(b.steps.length);
    expect(a.paySteps).toHaveLength(b.paySteps.length);
    expect(a.checks).toHaveLength(b.checks.length);
    expect(a.faq).toHaveLength(b.faq.length);
  });

  it.each(['ja', 'en'] as const)('%s: 利用料の率と最低額を直書きせず、ガス代不要の欄は開示の値の差し込み口を持つ', (locale) => {
    const c = orderLinkGuideContentFor(locale);
    for (const text of allText(c)) {
      expect(text, text).not.toMatch(/[0-9]\s*%/);
    }
    expect(c.feeGasless.focal).toBe('{recoverPercent}%');
    expect(c.feeGasless.body).toContain('{recoverPercent}');
    expect(c.feeGasless.body).toContain('{recoverFloor}');
  });

  it.each(['ja', 'en'] as const)('%s: 引いたボタン・画面の名前は今の画面の文言と一致する', (locale) => {
    const m = MESSAGES[locale];
    const o = m.OrderLinkBuilder;
    const known = new Set<string>([
      o.copy,
      o.share,
      o.nextOrder,
      o.switchToStandard,
      o.open,
      o.previewTitle,
      o.settingsOpen,
      o.verifyTitle,
      // 「ウォレットに {amount} JPYC 届いてから発送」は額を … にして引く。
      o.cautionTitle.replace('{amount}', '…'),
      m.Create.tabs.orderLink,
      m.Nav.sell,
      guideNavFor(locale).items.wallet.label,
    ]);
    const quote = locale === 'ja' ? /「([^」]+)」/g : /“([^”]+)”/g;
    const quoted = allText(orderLinkGuideContentFor(locale)).flatMap((text) => [...text.matchAll(quote)].map((x) => x[1]));
    expect(quoted.length).toBeGreaterThan(5);
    for (const q of quoted) expect(known.has(q), `${locale}: 画面に無い名前「${q}」`).toBe(true);
  });

  it.each(['ja', 'en'] as const)('%s: お店の責任の文は画面と同じ', (locale) => {
    expect(orderLinkGuideContentFor(locale).sellerDuty).toBe(MESSAGES[locale].OrderLinkBuilder.sellerDuty);
  });

  it.each(['ja', 'en'] as const)('%s: metadata は /guide/order-link を正規の URL にする', (locale) => {
    const meta = orderLinkGuideMetadata(locale);
    expect(String(meta.alternates?.canonical)).toContain(`/${locale}/guide/order-link`);
    expect(meta.title).toBe(orderLinkGuideContentFor(locale).metaTitle);
  });
});
