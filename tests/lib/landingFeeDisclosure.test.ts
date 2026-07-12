// 公開ランディングの「OpenPay 利用料について」(LandingSupport の supportBody) の料率が、
// 単一情報源である lib/legal.ts の DISCLOSED 定数と一致していることを固定する drift フェンス。
//
// supportBody は店主・お客様が読む公開の利用料まとめ。DISCLOSED 定数 (実際に徴収する/開示する
// 料率の SOT) を変更したのに公開文面を直し忘れると、表示と実態が食い違う。news.ts の L4 フェンス
// と同型で、対象を Landing copy にしたもの。LandingSupport 自体は presentational な async server
// component (描画テストの慣習対象外) なので、内容の正しさはこの drift フェンスで担保する。

import { describe, it, expect } from 'vitest';
import { DISCLOSED_RECOVER_FEE, DISCLOSED_MOBILE_ORDER_FEE } from '@/lib/legal';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';

const recoverPct = DISCLOSED_RECOVER_FEE.percentFromJulyBps / 100; // 1 (%)
const floorJpyc = DISCLOSED_RECOVER_FEE.floorJpyc; // 2 (JPYC)
const storefrontPct = DISCLOSED_MOBILE_ORDER_FEE.storefrontBps / 100; // 1 (%)
const preorderPct = DISCLOSED_MOBILE_ORDER_FEE.preorderBps / 100; // 3 (%)

describe('LandingSupport 料率カード ↔ DISCLOSED 料率 (drift フェンス)', () => {
  for (const [loc, msgs] of [
    ['ja', ja],
    ['en', en],
  ] as const) {
    it(`${loc}: 決済QR/レジ ${recoverPct}%・最低 ${floorJpyc} JPYC、モバイル注文 ${storefrontPct}%/${preorderPct}%`, () => {
      const L = msgs.Landing;
      // 決済QR カード = 決済額の 1%・最低 2 JPYC
      expect(L.supportFeePayBody).toContain(`${recoverPct}%`);
      expect(L.supportFeePayBody).toContain(`${floorJpyc} JPYC`);
      // モバイル注文カード = 店頭・券売機 1% / 事前 3%
      expect(L.supportFeeMobileBody).toContain(`${storefrontPct}%`);
      expect(L.supportFeeMobileBody).toContain(`${preorderPct}%`);
      // チップカード = ガス相当 約 2 JPYC (送るお客様が負担)
      expect(L.supportFeeTipBody).toContain(`${floorJpyc} JPYC`);
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
});
