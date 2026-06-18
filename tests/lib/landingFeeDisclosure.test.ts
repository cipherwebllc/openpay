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

describe('LandingSupport supportBody ↔ DISCLOSED 料率 (drift フェンス)', () => {
  for (const [loc, msgs] of [
    ['ja', ja],
    ['en', en],
  ] as const) {
    it(`${loc}: 決済QR/レジ ${recoverPct}%・最低 ${floorJpyc} JPYC、モバイル注文 ${storefrontPct}%/${preorderPct}%`, () => {
      const body = msgs.Landing.supportBody;
      expect(body).toContain(`${recoverPct}%`); // 決済QR・レジ = 決済額の 1%
      expect(body).toContain(`${floorJpyc} JPYC`); // 最低 2 JPYC / チップのガス相当 約 2 JPYC
      expect(body).toContain(`${storefrontPct}%`); // モバイル注文 店頭・券売機 1%
      expect(body).toContain(`${preorderPct}%`); // モバイル注文 事前 3%
    });
  }
});
