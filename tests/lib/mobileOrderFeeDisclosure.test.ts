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
