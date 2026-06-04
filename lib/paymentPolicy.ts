// payMode / gasMode を「決済設定」の自然文サマリ用キーに集約する。
// UI は返ったキーを各 namespace の i18n 文字列にマップする (labels-as-props)。
// QrGenerator の高度設定サマリと RegisterMode の読み取りサマリで共有する。

import type { GasMode, PayMode } from '@/lib/fee';

export type PaymentPolicyKey =
  | 'standard'
  | 'gaslessCustomerGas'
  | 'gaslessMerchantGas';

export function paymentPolicyKey(
  payMode: PayMode,
  gasMode: GasMode,
): PaymentPolicyKey {
  // standard では gasMode は無視される (PaymentForm 側も同様)。
  if (payMode === 'standard') return 'standard';
  return gasMode === 'customer' ? 'gaslessCustomerGas' : 'gaslessMerchantGas';
}
