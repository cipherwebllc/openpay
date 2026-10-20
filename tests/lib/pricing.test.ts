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
import {
  PRICING,
  PRICING_CALC_MODE_IDS,
  PRICING_ROW_IDS,
  PRICING_SUMMARY_IDS,
  pricingContentFor,
  pricingMetadata,
  type PricingContent,
} from '@/lib/pricing';

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
      expect(content.summary.map((item) => item.id)).toEqual([...PRICING_SUMMARY_IDS]);
      expect(content.calc.modes.map((mode) => mode.id)).toEqual([...PRICING_CALC_MODE_IDS]);
      expect(content.trust).toHaveLength(2);
      expect(content.otherTitles).toHaveLength(content.otherItems.length);
      for (const row of content.rows) {
        expect(row.standard.length, row.id).toBeGreaterThan(0);
        expect(row.gasless.length, row.id).toBeGreaterThan(0);
        expect(row.details.length, row.id).toBeGreaterThan(0);
      }
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
    expect(text).toContain(DISCLOSED_DUAL_RAIL_USDC.arcChainName);
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

  it('リードは承認を求める案の文 (2026-10-12・料金ページの磨き)', () => {
    expect(PRICING.ja.lead).toBe(
      'お客様がガス代を払う通常決済なら、OpenPay の料金はかかりません（モバイル注文を除きます）。',
    );
    expect(PRICING.ja.summaryTitle).toBe('料金がかかるのは、この 4 つです');
  });

  it('4 つの場合に、規約での呼び名と払う人を書く', () => {
    const names = {
      ja: ['OpenPay 利用料', 'モバイル注文の利用料', 'ガス代相当', 'x402 利用料'],
      en: ['OpenPay usage fee', 'Mobile order fee', 'Gas equivalent', 'x402 fee'],
    } as const;
    const payers = {
      ja: ['お店が払う', 'お店が払う', '送る方が払う', '買い手が払う'],
      en: ['Shop pays', 'Shop pays', 'Sender pays', 'Buyer pays'],
    } as const;
    for (const locale of LOCALES) {
      PRICING[locale].summary.forEach((item, index) => {
        expect(item.feeName).toBe(names[locale][index]);
        expect(item.payer.label).toBe(payers[locale][index]);
      });
    }
    // 見出しは「だけ」と言わない (お店がガス代を肩代わりの 1 wei は表の行で開示する)。
    expect(PRICING.ja.summaryTitle).not.toContain('だけ');
    expect(PRICING.en.summaryTitle).not.toMatch(/\bonly\b/);
    for (const locale of LOCALES) {
      const storeGas = PRICING[locale].rows.find((row) => row.id === 'storeGas');
      expect(storeGas?.gasless).toEqual([{ rail: 'JPYC', value: `${DISCLOSED_STORE_GAS_WALLET.feeWei} wei` }]);
      expect(storeGas?.details.join('')).toContain(locale === 'ja' ? 'OpenPay に届きます' : 'goes to OpenPay');
      expect(storeGas?.details.join('')).toContain(locale === 'ja' ? 'OpenPay 利用料は 0 円' : 'OpenPay usage fee: 0');
    }
    // 払う人の dt は「払う人」(お店がガス代を肩代わりの行は中身がガス代と 1 wei で、利用料ではない)。
    expect(PRICING.ja.dtPayer).toBe('払う人');
    expect(PRICING.en.dtPayer).toBe('Who pays');
  });

  it('JPYC のチップは「OpenPay に届く」・USDC のチップは「OpenPay は受け取らない」(D1 の再発防止)', () => {
    for (const locale of LOCALES) {
      const tip = PRICING[locale].rows.find((row) => row.id === 'tip');
      if (!tip) throw new Error('tip row');
      const jpycPart = tip.details.find((d) => d.startsWith('JPYC: '));
      const usdcBasePart = tip.details.find((d) => d.startsWith('USDC (Base)'));
      const usdcArcPart = tip.details.find((d) => d.startsWith('USDC (Arc)'));
      expect(jpycPart).toContain(locale === 'ja' ? 'OpenPay に届きます' : 'goes to OpenPay');
      expect(jpycPart).not.toMatch(/受け取りません|receives nothing/);
      expect(usdcBasePart).toContain(locale === 'ja' ? 'OpenPay は受け取りません' : 'OpenPay receives nothing');
      expect(usdcArcPart).toContain(locale === 'ja' ? 'OpenPay は受け取りません' : 'OpenPay receives nothing');
      // 表のマス: JPYC は約 2 JPYC (OpenPay に届く)・USDC は通常決済 (Arc)・ガスレス (Base) とも「なし」。
      expect(tip.gasless[0]).toEqual({ rail: 'JPYC', value: locale === 'ja' ? `約 ${DISCLOSED_TIP_FEE_MODELS.jpycRelay.floorJpyc} JPYC` : `about ${DISCLOSED_TIP_FEE_MODELS.jpycRelay.floorJpyc} JPYC` });
      expect(tip.standard[0].rail).toBe('USDC (Arc)');
      expect(tip.gasless[1].rail).toBe('USDC (Base)');
    }
  });

  it('AI エージェントが x402 で払うモバイル注文は、モバイル注文の利用料ではなく x402 利用料 (規約 第 5 条 (8) ただし書き)', () => {
    const ja = PRICING.ja;
    const en = PRICING.en;
    expect(ja.summary[3].detail).toContain('AI エージェントが x402 で払うモバイル注文も含みます');
    expect(ja.summary[1].detail).toContain('注文ページで払う注文');
    expect(ja.rows.find((row) => row.id === 'mobile')?.details.join('')).toContain('この料率ではなく x402 利用料');
    expect(ja.otherItems[0]).toContain('モバイル注文の利用料ではなく、この x402 利用料だけがかかります');
    expect(en.summary[3].detail).toContain('including mobile orders an AI agent pays over x402');
    expect(en.rows.find((row) => row.id === 'mobile')?.details.join('')).toContain('instead of these rates');
    expect(en.otherItems[0]).toContain('charged only this x402 fee, not the mobile order fee');
  });

  it('お店がガス代を肩代わりの対象外は規約 第 5 条 (11) と同じ範囲 (印刷・保存・URL のコピー・金額なし)', () => {
    const ja = PRICING.ja.rows.find((row) => row.id === 'storeGas')?.details.join('');
    const en = PRICING.en.rows.find((row) => row.id === 'storeGas')?.details.join('');
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
