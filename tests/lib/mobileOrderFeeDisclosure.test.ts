import { describe, it, expect } from 'vitest';
import jaMessages from '@/messages/ja.json';
import enMessages from '@/messages/en.json';
import {
  DISCLOSED_MOBILE_ORDER_FEE,
  mobileOrderFeeDisclosureDivergence,
} from '@/lib/legal';
import { STOREFRONT_FEE_BPS, PREORDER_FEE_BPS } from '@/lib/mobileOrderFee';

// フェンス: 実装の料率 (lib/mobileOrderFee) ↔ 開示済み定数 (lib/legal) ↔ 法務本文 (messages) の三者が
// 一致することを保証する。どれか一つを変えて他を放置すると fail する (= 開示の黙った嘘を防ぐ)。
describe('mobile-order fee disclosure fence', () => {
  it('code rates match the disclosed constants (no divergence)', () => {
    expect(STOREFRONT_FEE_BPS).toBe(DISCLOSED_MOBILE_ORDER_FEE.storefrontBps);
    expect(PREORDER_FEE_BPS).toBe(DISCLOSED_MOBILE_ORDER_FEE.preorderBps);
    expect(mobileOrderFeeDisclosureDivergence()).toBeNull();
  });

  it('disclosed rates are 1% (storefront) and 3% (preorder)', () => {
    expect(DISCLOSED_MOBILE_ORDER_FEE.storefrontBps).toBe(100);
    expect(DISCLOSED_MOBILE_ORDER_FEE.preorderBps).toBe(300);
  });

  it('ja legal/marketing text discloses the mobile-order system fee at 1% / 3%', () => {
    const ja = JSON.stringify(jaMessages);
    expect(ja).toContain('モバイル注文システム利用料');
    expect(ja).toContain('店頭・券売機が決済額の 1%');
    expect(ja).toContain('事前モバイルオーダーが決済額の 3%');
  });

  it('en legal/marketing text discloses the mobile-order system fee at 1% / 3%', () => {
    const en = JSON.stringify(enMessages);
    expect(en).toContain('mobile-order system fee');
    expect(en).toContain('1% of the payment for in-store/kiosk');
    expect(en).toContain('3% for pre-order mobile ordering');
  });

  it('the fee is disclosed as path-independent (not a gas-sponsorship fee)', () => {
    const ja = JSON.stringify(jaMessages);
    // 通常決済でも申し受ける旨が明示されている (経路非依存の核)
    expect(ja).toContain('通常決済であっても');
    const en = JSON.stringify(enMessages);
    expect(en).toContain('regardless of the payment path');
  });
});

// 2026-10-07: レジの通常決済の利用料 (2026 年 7 月から 1%) を廃止。Terms 第3条・第5条 / 免責 §7 / 特商法 役務の対価
// に「廃止日と過去分」を明記し、旧の carve-in (通常決済でも 1% を申し受ける) は残さない。
describe('register (レジ) standard fee abolition disclosure', () => {
  it('ja: 廃止の文が load-bearing 文書に入り、旧の carve-in は無い', () => {
    const ja = JSON.stringify(jaMessages);
    const count = (
      ja.match(/レジ \(店頭POS\) 機能を用いてお会計した JPYC の通常決済 \(ガスあり\) モードの決済についても、2026 年 10 月 7 日以降のご利用分から OpenPay 利用料は発生しません/g) || []
    ).length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(ja).not.toContain('通常決済 (ガスあり) モードであっても、2026 年 7 月のご利用分から');
  });

  it('en: abolition sentence present and the old carve-in removed', () => {
    const en = JSON.stringify(enMessages);
    const count = (en.match(/in Standard \(with-gas\) mode also have no OpenPay usage fee for usage from October 7, 2026/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(en).not.toContain('even in Standard (with-gas) mode');
    expect(en).not.toContain('from the July 2026 usage period the same OpenPay usage fee');
  });
});
