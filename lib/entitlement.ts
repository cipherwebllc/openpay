// アルファ全開放スイッチ。旧「30日 利用権 tier」ストアは a1 OpenPay 利用料への一本化で退役したが
// (2026-06-09・[[monetization-strategy]])、この `entitlementBypass` だけは a1 が流用する:
//   - lib/feeCurrent: bypass 中は常に fee-current 扱い (請求しない)
//   - lib/feeGate:    bypass 中は relay 関所を遮断しない
// ALPHA_ENTITLEMENT_BYPASS は a1 と共有の「アルファ全開放」フラグ (既定 ON)。
// server 専用 (process.env を読む)。

/** 既定 true (アルファ = 全開放)。'0' / 'false' で課金 (利用料必須) 運用へ切替。 */
export function entitlementBypass(): boolean {
  const v = process.env.ALPHA_ENTITLEMENT_BYPASS;
  return !(v === '0' || v === 'false');
}
