// 公開ランディングの「OpenPay 利用料について」(LandingSupport の supportBody) の料率が、
// 単一情報源である lib/legal.ts の DISCLOSED 定数と一致していることを固定する drift フェンス。
//
// supportBody は店主・お客様が読む公開の利用料まとめ。DISCLOSED 定数 (実際に徴収する/開示する
// 料率の SOT) を変更したのに公開文面を直し忘れると、表示と実態が食い違う。news.ts の L4 フェンス
// と同型で、対象を Landing copy にしたもの。LandingSupport 自体は presentational な async server
// component (描画テストの慣習対象外) なので、内容の正しさはこの drift フェンスで担保する。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import {
  LANDING_PAYMENT_FEE_VALUES,
  DISCLOSED_RECOVER_FEE,
  DISCLOSED_TIP_FEE_MODELS,
  DISCLOSED_MOBILE_ORDER_FEE,
  DISCLOSED_STORE_USDC_PAYMENT,
  DISCLOSED_X402_FEE,
} from '@/lib/legal';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';

const recoverPct = DISCLOSED_RECOVER_FEE.percentFromJulyBps / 100; // 1 (%)
const floorJpyc = DISCLOSED_RECOVER_FEE.floorJpyc; // 2 (JPYC)
const storefrontPct = DISCLOSED_MOBILE_ORDER_FEE.storefrontBps / 100; // 1 (%)
const preorderPct = DISCLOSED_MOBILE_ORDER_FEE.preorderBps / 100; // 3 (%)
const x402Pct = DISCLOSED_X402_FEE.bps / 100; // 1 (%)
const x402FloorJpyc = DISCLOSED_X402_FEE.floorJpyc; // 1 (JPYC)
const storeUsdcPct = DISCLOSED_STORE_USDC_PAYMENT.openPayFeeBps / 100; // 0 (%)

describe('standard-payment fee scope (review 6 regression)', () => {
  it('README scopes standard and USDC exemptions and includes register and mobile-order fees', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const paragraph = readme.split('\n\n').find((text) => text.startsWith('There are **no'))!;
    expect(paragraph).toContain("**standard** (with-gas) mode outside the register's JPYC path and mobile orders");
    expect(paragraph).toContain('**USDC** paths outside mobile orders');
    expect(paragraph).toContain("plus the register's standard JPYC path and mobile orders described below");
    expect(paragraph).not.toContain('The usage fee applies only');
  });

  for (const [locale, messages] of [['ja', ja], ['en', en]] as const) {
    const t = createTranslator({ locale, messages, namespace: 'Landing' });
    const values = {
      recoverPercent: recoverPct,
      recoverFloor: floorJpyc,
      // cashSimNote は #595 (E13/D5) 以降 percent / floor を引数にとる (SavingsSimulator が
      // DISCLOSED_RECOVER_FEE から渡す)。同じ値を両方の名前で渡す。
      percent: recoverPct,
      floor: floorJpyc,
      tipFloor: DISCLOSED_TIP_FEE_MODELS.jpycRelay.floorJpyc,
      registerPercent: recoverPct,
      storefrontPercent: storefrontPct,
      preorderPercent: preorderPct,
    };
    it.each(['cashCellFeeOpenPayNote', 'benefitsFeeBody', 'supportFeeRegisterBody', 'faqA6'] as const)(`${locale}: %s discloses merchant-paid register JPYC including standard mode`, (key) => {
      const text = t(key, values);
      expect(text).toMatch(locale === 'ja' ? /レジ/ : /register/i);
      expect(text).toMatch(locale === 'ja' ? /通常決済/ : /standard/i);
      expect(text).toMatch(locale === 'ja' ? /店舗.{0,4}負担/ : /merchant.{0,4}(?:paid|bears)/i);
      expect(text).toContain(`${recoverPct}%`);
      expect(text).toContain(`${floorJpyc} JPYC`);
    });
    it(`${locale}: QR and simulator exemptions exclude register and mobile order`, () => {
      for (const key of ['supportFeePayBody', 'cashSimNote'] as const) {
        const text = t(key, values);
        expect(text).toMatch(locale === 'ja' ? /レジ.*モバイル注文.*除く/ : /excluding.*register.*mobile order/i);
      }
      expect(t('cashSimNote', values)).toContain(`${floorJpyc} JPYC`);
    });
  }
});

describe('LandingSupport 料率カード ↔ DISCLOSED 料率 (drift フェンス)', () => {
  for (const [loc, msgs] of [
    ['ja', ja],
    ['en', en],
  ] as const) {
    it(`${loc}: 決済QR/レジ ${recoverPct}%・最低 ${floorJpyc} JPYC、モバイル注文 ${storefrontPct}%/${preorderPct}%`, () => {
      const t = createTranslator({ locale: loc, messages: msgs, namespace: 'Landing' });
      // 決済QR カード = 決済額の 1%・最低 2 JPYC
      expect(t('supportFeePayBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${recoverPct}%`);
      expect(t('supportFeePayBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${floorJpyc} JPYC`);
      // モバイル注文カード = 店頭・券売機 1% / 事前 3%
      expect(t('supportFeeMobileBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${storefrontPct}%`);
      expect(t('supportFeeMobileBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${preorderPct}%`);
      // チップカード = ガス相当 約 2 JPYC (送るお客様が負担)
      expect(t('supportFeeTipBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${floorJpyc} JPYC`);
      // デジタル商品カード: JPYC を主表示にして買い手 x402 1%・最低 1 JPYC、
      // USDC (Base) は OpenPay x402 利用料 0%・売り手手数料なし。
      expect(t('supportFeeStoreFocal', LANDING_PAYMENT_FEE_VALUES)).toBe(`JPYC ${x402Pct}%`);
      expect(t('supportFeeStoreBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${x402Pct}%`);
      expect(t('supportFeeStoreBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${x402FloorJpyc} JPYC`);
      expect(t('supportFeeStoreBody', LANDING_PAYMENT_FEE_VALUES)).toContain(
        DISCLOSED_STORE_USDC_PAYMENT.chainName,
      );
      expect(t('supportFeeStoreBody', LANDING_PAYMENT_FEE_VALUES)).toContain(`${storeUsdcPct}%`);
      // チップカードの focal も顧客負担の実額 (ガス相当 約 2 JPYC)
      expect(t('supportFeeTipFocal', LANDING_PAYMENT_FEE_VALUES)).toContain(`${floorJpyc}`);
    });
  }

  it('TipEmbedGenerator: 受取無料・送る側が約 2 JPYC 負担・1% 不適用を ja/en で固定する', () => {
    // チップ専用の DISCLOSED 定数はないため、共通の開示フロア数値と
    // 「1% 不適用・送る側負担」というチップ固有の意味をコピー側で固定する。
    const jaNote = ja.TipEmbedGenerator.feeNote;
    expect(jaNote).toContain('チップの受け取りに手数料はかかりません');
    expect(jaNote).toContain('決済額の 1% は適用されません');
    expect(jaNote).toContain('送る方');
    expect(jaNote).toContain(`約 ${floorJpyc} JPYC`);

    const enNote = en.TipEmbedGenerator.feeNote;
    expect(enNote).toContain('Receiving tips is free');
    expect(enNote).toContain('the 1% fee does not apply');
    expect(enNote).toContain('The sender covers');
    expect(enNote).toContain(`about ${floorJpyc} JPYC`);
  });

  // 2026-08-24 磨き上げで、開示は見出し (subtitle) からカタログ脚注 (catalogFeeNote*) へ移した。
  // JPYC のみ / JPYC+USDC 混在の両脚注に料率・最低額・支払う側の上乗せが載ることを固定する。
  it('AIストア: x402 利用料率・最低額・支払う側の上乗せを ja/en で固定する', () => {
    for (const key of ['catalogFeeNoteJpyc', 'catalogFeeNoteBoth'] as const) {
      const jaNote = ja.Facilitator[key];
      expect(jaNote, `ja ${key}`).toContain(`${x402Pct}%`);
      expect(jaNote, `ja ${key}`).toContain(`最低 ${x402FloorJpyc} JPYC`);
      expect(jaNote, `ja ${key}`).toContain('支払う側の上乗せ');

      const enNote = en.Facilitator[key];
      expect(enNote, `en ${key}`).toContain(`${x402Pct}%`);
      expect(enNote, `en ${key}`).toContain(`min ${x402FloorJpyc} JPYC`);
      expect(enNote, `en ${key}`).toContain('paid by the buyer');
    }
    // USDC 混在の脚注は「上乗せなし」も明示する (JPYC との違いを買い手が誤認しない)
    expect(ja.Facilitator.catalogFeeNoteBoth).toContain('USDC は上乗せなし');
    expect(en.Facilitator.catalogFeeNoteBoth).toContain('no markup');
  });
});
