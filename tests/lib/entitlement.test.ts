// 旧「利用権 tier ストア」は a1 OpenPay 利用料への一本化で退役 (2026-06-09)。
// 残ったのは a1 が流用する `entitlementBypass` (ALPHA_ENTITLEMENT_BYPASS) のみ。
import { describe, it, expect, afterEach } from 'vitest';
import { entitlementBypass } from '@/lib/entitlement';

describe('entitlementBypass (アルファ全開放スイッチ)', () => {
  afterEach(() => {
    delete process.env.ALPHA_ENTITLEMENT_BYPASS;
  });

  it('未設定 → true (既定 = 全開放)', () => {
    delete process.env.ALPHA_ENTITLEMENT_BYPASS;
    expect(entitlementBypass()).toBe(true);
  });

  it("'0' → false (課金運用)", () => {
    process.env.ALPHA_ENTITLEMENT_BYPASS = '0';
    expect(entitlementBypass()).toBe(false);
  });

  it("'false' → false (課金運用)", () => {
    process.env.ALPHA_ENTITLEMENT_BYPASS = 'false';
    expect(entitlementBypass()).toBe(false);
  });

  it("その他の値 (例 '1'/'true'/空) → true", () => {
    for (const v of ['1', 'true', '', 'yes']) {
      process.env.ALPHA_ENTITLEMENT_BYPASS = v;
      expect(entitlementBypass()).toBe(true);
    }
  });
});
