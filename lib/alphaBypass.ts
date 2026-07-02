// アルファ全開放スイッチ。旧「30日 利用権 tier」ストアは a1 OpenPay 利用料への一本化で退役したが
// (2026-06-09・[[monetization-strategy]])、この `entitlementBypass` だけは a1 が流用する:
//   - lib/feeCurrent: bypass 中は常に fee-current 扱い (請求しない)
//   - lib/feeGate:    bypass 中は relay 関所を遮断しない
// ALPHA_ENTITLEMENT_BYPASS は a1 と共有の「アルファ全開放」フラグ (既定 ON)。
// server 専用 (process.env を読む)。

import { logger } from '@/lib/logger';

// プロセスごとに 1 回だけ warn を出す (relay hot path でのスパム防止)。
let _warnedUnrecognized = false;

/**
 * 既定 true (アルファ = 全開放)。
 * OFF 集合 ('0'/'false'/'no'/'off') → false、ON 集合 ('1'/'true'/'yes'/'on') → true。
 * 未設定 / '' → true (アルファ既定 ON の文書化済み挙動を維持)。
 * 認識不能な値 → false (fail-closed)。
 * 理由: money gate では「typo で無徴収が無signal 継続」(fail-open) より
 *        「ゲートが現れて気づける」(fail-closed) に倒す。
 */
export function entitlementBypass(): boolean {
  const v = process.env.ALPHA_ENTITLEMENT_BYPASS;
  // 未設定または空文字 → アルファ既定 ON
  if (v === undefined || v === '') return true;

  const n = v.trim().toLowerCase();
  if (n === '0' || n === 'false' || n === 'no' || n === 'off') return false;
  if (n === '1' || n === 'true' || n === 'yes' || n === 'on') return true;

  // 認識不能 → fail-closed + 1回だけ警告
  if (!_warnedUnrecognized) {
    _warnedUnrecognized = true;
    logger.warn('billing.bypass.unrecognized', { value: v });
  }
  return false;
}
