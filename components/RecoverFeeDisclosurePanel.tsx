'use client';

// Recover モードの手数料開示パネル。bps=0 → 固定ガス形式、bps>0 → % 形式。
// FREE モード (forwarder 未設定) は buildRecoverFeeDisplay が null を返すため
// このコンポーネントは一切描画しない = 現行挙動に変更なし。

import type { RecoverFeeDisplay } from '@/lib/recoverFeeDisplay';

type Props = {
  disclosure: RecoverFeeDisplay;
  /** 手数料ラベルの i18n 済み文字列。 */
  feeLabel: string;
  /** 顧客/店主分担のラベル。 */
  splitLabel: string;
};

export function RecoverFeeDisclosurePanel({ disclosure: _, feeLabel, splitLabel }: Props) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
      <p className="font-semibold">{feeLabel}</p>
      <p className="mt-0.5 text-amber-800">{splitLabel}</p>
    </div>
  );
}
