// 料金ページ (/pricing) の本文 (lib/pricing.ts) のフェンス (plans/pricing-page.md §7.1 ④〜⑦)。
// ④ ja/en の形がそろう ⑤ 開示値が本文に入る ⑥ 禁止語・JPYC のチップの行き先 (D1 の再発防止)・呼び名
// ⑦ metadata。数字が正本 (DISCLOSED_*) から差し込まれること自体は tests/app/pricingNoHardcode.test.tsx が見る。

import { describe, expect, it } from 'vitest';
import {
  DISCLOSED_DUAL_RAIL_USDC,
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_STORE_GAS_WALLET,
  DISCLOSED_STORE_USDC_PAYMENT,
  DISCLOSED_TIP_FEE_MODELS,
  DISCLOSED_X402_FEE,
  disclosedStoreGasChains,
} from '@/lib/legal';
import { PRICING, PRICING_ROW_IDS, pricingContentFor, pricingMetadata, type PricingContent } from '@/lib/pricing';

const LOCALES = ['ja', 'en'] as const;

// 形 (キーの並び・配列の長さ) を取り出す。leaf は型名だけにする。
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, shape(v)]));
  }
  return value === null ? 'null' : typeof value;
}

function leaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(leaves);
  return [];
}

function allText(content: PricingContent): string {
  return leaves(content).join('\n');
}

const pct = (bps: number) => `${bps / 100}%`;

describe('④ ja/en の形', () => {
  it('キー・行の並び・配列の長さがそろい、空の文字列が無い', () => {
    expect(shape(PRICING.ja)).toEqual(shape(PRICING.en));
    for (const locale of LOCALES) {
      const content = PRICING[locale];
      expect(content.rows.map((row) => row.id)).toEqual([...PRICING_ROW_IDS]);
      expect(content.cases).toHaveLength(4);
      expect(content.examples).toHaveLength(3);
      for (const table of content.examples) expect(table.rows).toHaveLength(3);
      for (const text of leaves(content)) expect(text.trim(), locale).not.toBe('');
      // 補間の漏れ (テンプレートや ICU の波括弧) が無い。
      expect(allText(content)).not.toMatch(/[{}]|undefined|NaN/);
    }
  });

  it('未知ロケールは ja', () => {
    expect(pricingContentFor('fr')).toBe(PRICING.ja);
    expect(pricingContentFor('en')).toBe(PRICING.en);
  });
});

describe('⑤ 開示値が本文に入る (今の正本)', () => {
  it.each(LOCALES)('%s', (locale) => {
    const text = allText(PRICING[locale]);
    const r = pct(DISCLOSED_RECOVER_FEE.percentFromJulyBps);
    const f = DISCLOSED_RECOVER_FEE.floorJpyc;
    const xf = DISCLOSED_X402_FEE.floorJpyc;
    expect(text).toContain(r);
    expect(text).toContain(locale === 'ja' ? `最低 ${f} JPYC` : `minimum ${f} JPYC`);
    expect(text).toContain(pct(DISCLOSED_MOBILE_ORDER_FEE.storefrontBps));
    expect(text).toContain(pct(DISCLOSED_MOBILE_ORDER_FEE.preorderBps));
    expect(text).toContain(
      locale === 'ja'
        ? `約 ${DISCLOSED_TIP_FEE_MODELS.jpycRelay.floorJpyc} JPYC`
        : `about ${DISCLOSED_TIP_FEE_MODELS.jpycRelay.floorJpyc} JPYC`,
    );
    expect(text).toContain(pct(DISCLOSED_X402_FEE.bps));
    expect(text).toContain(locale === 'ja' ? `最低 ${xf} JPYC` : `minimum ${xf} JPYC`);
    expect(text).toContain(DISCLOSED_STORE_USDC_PAYMENT.chainName);
    expect(text).toContain(DISCLOSED_DUAL_RAIL_USDC.chainName);
    expect(text).toContain(disclosedStoreGasChains(locale));
    expect(text).toContain(`${DISCLOSED_STORE_GAS_WALLET.feeWei} wei`);
  });
});

describe('⑥ 言い回し', () => {
  it.each([
    ['ja', /預か|保管|残高|チャージ|必ず|保証|最安|お得|ずっと|永久|両替|換算/],
    ['en', /guarantee|cheapest|forever|custod|deposit|top.?up|\bbalance\b|\balways\b|convert|exchange/i],
  ] as const)('%s: 非カストディ・断定・換算の語を使わない', (locale, banned) => {
    expect(allText(PRICING[locale])).not.toMatch(banned);
  });

  it('リードは user 承認済みの文 (2026-10-11)', () => {
    expect(PRICING.ja.lead).toBe(
      'お客様がガス代を払う通常決済で受け取るなら、OpenPay の料金はかかりません（モバイル注文を除きます）。OpenPay に料金を払うのは、次の場合だけです。',
    );
  });

  it('4 つの場合に、規約での呼び名と払う人を書く', () => {
    const names = {
      ja: ['OpenPay 利用料', 'モバイル注文の利用料', 'ガス代相当', 'x402 利用料'],
      en: ['the OpenPay usage fee', 'the mobile order fee', 'the gas equivalent', 'the x402 fee'],
    } as const;
    const payers = {
      ja: ['お店が払います', 'お店が払います', '送る方が払います', '買い手が払います'],
      en: ['paid by the shop', 'paid by the shop', 'paid by the sender', 'paid by the buyer'],
    } as const;
    for (const locale of LOCALES) {
      PRICING[locale].cases.forEach((text, index) => {
        expect(text).toContain(names[locale][index]);
        expect(text).toContain(payers[locale][index]);
      });
    }
    // 払う人の dt は「払う人」(お店がガス代を肩代わりの行は中身がガス代と 1 wei で、利用料ではない)。
    expect(PRICING.ja.dtPayer).toBe('払う人');
    expect(PRICING.en.dtPayer).toBe('Who pays');
  });

  it('JPYC のチップは「OpenPay に届く」・USDC のチップは「OpenPay は受け取らない」(D1 の再発防止)', () => {
    for (const locale of LOCALES) {
      const tip = PRICING[locale].rows.find((row) => row.id === 'tip');
      if (!tip) throw new Error('tip row');
      const [jpycPart, usdcBasePart] = tip.gasless.split(/(?=USDC \(Base\))/);
      expect(jpycPart).toMatch(/^JPYC: /);
      expect(jpycPart).toContain(locale === 'ja' ? 'OpenPay に届きます' : 'goes to OpenPay');
      expect(jpycPart).not.toMatch(/受け取りません|receives nothing/);
      expect(usdcBasePart).toContain(locale === 'ja' ? 'OpenPay は受け取りません' : 'OpenPay receives nothing');
      expect(tip.standard).toMatch(/^USDC \(Arc\)/);
      expect(tip.standard).toContain(locale === 'ja' ? 'OpenPay は受け取りません' : 'OpenPay receives nothing');
    }
  });

  it('AI エージェントが x402 で払うモバイル注文は、モバイル注文の利用料ではなく x402 利用料 (規約 第 5 条 (8) ただし書き)', () => {
    const ja = PRICING.ja;
    const en = PRICING.en;
    expect(ja.cases[3]).toContain('AI エージェントが x402 で払うモバイル注文を含みます');
    expect(ja.cases[1]).toContain('お客様が注文ページで払うモバイル注文');
    expect(ja.rows.find((row) => row.id === 'mobile')?.note).toContain('この料率ではなく x402 利用料');
    expect(ja.otherItems[0]).toContain('モバイル注文の利用料ではなく、この x402 利用料だけがかかります');
    expect(en.cases[3]).toContain('including mobile orders an AI agent pays over x402');
    expect(en.rows.find((row) => row.id === 'mobile')?.note).toContain('instead of these rates');
    expect(en.otherItems[0]).toContain('charged only this x402 fee, not the mobile order fee');
  });

  it('お店がガス代を肩代わりの対象外は規約 第 5 条 (11) と同じ範囲 (印刷・保存・URL のコピー・金額なし)', () => {
    const ja = PRICING.ja.rows.find((row) => row.id === 'storeGas')?.gasless;
    const en = PRICING.en.rows.find((row) => row.id === 'storeGas')?.gasless;
    expect(ja).toContain('印刷・保存・URL をコピーした QR と、金額を指定しない QR は対象外です');
    expect(en).toContain('printed, saved or copied as a URL, or that have no amount, are not eligible');
  });
});

describe('⑦ metadata', () => {
  it.each(LOCALES)('%s: canonical・hreflang・OG 画像・description に数字なし', (locale) => {
    const meta = pricingMetadata(locale);
    expect(meta.title).toBe(PRICING[locale].metaTitle);
    expect(meta.alternates?.canonical).toBe(`/${locale}/pricing`);
    expect(meta.alternates?.languages).toEqual({ ja: '/ja/pricing', en: '/en/pricing' });
    const images = meta.openGraph?.images;
    expect(Array.isArray(images) ? images.map((image) => (typeof image === 'object' && 'url' in image ? image.url : image)) : images).toEqual(['/og-home.webp']);
    expect(String(meta.description)).not.toMatch(/\d/);
    // タイトルに OpenPay を 2 回出さない。
    expect(String(meta.title).match(/OpenPay/g)).toHaveLength(1);
  });

  it('未知ロケールは ja (canonical が存在しない URL にならない)', () => {
    const meta = pricingMetadata('fr');
    expect(meta.alternates?.canonical).toBe('/ja/pricing');
    expect(meta.title).toBe(PRICING.ja.metaTitle);
  });
});
