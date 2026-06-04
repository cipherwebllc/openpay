'use client';

// 受取先アドレス入力欄の下に出す「接続中のウォレットを使う」チップ + 一致バッジ。
// QR / レジ / Tip の 3 タブで共有。ラベルは各タブの namespace から渡す (i18n)。
// 表示判定は useReceiverAutofill の canUse / matches に従う。

import { Check, Wallet } from 'lucide-react';

export function ReceiverWalletChip({
  canUse,
  matches,
  onUse,
  useLabel,
  matchLabel,
}: {
  canUse: boolean;
  matches: boolean;
  onUse: () => void;
  useLabel: string;
  matchLabel: string;
}) {
  if (matches) {
    return (
      <p className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
        <Check className="h-3.5 w-3.5" aria-hidden />
        {matchLabel}
      </p>
    );
  }
  if (!canUse) return null;
  return (
    <button
      type="button"
      onClick={onUse}
      className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/5 px-2.5 py-1 text-xs font-medium text-brand-dark transition hover:bg-brand/10"
    >
      <Wallet className="h-3.5 w-3.5" aria-hidden />
      {useLabel}
    </button>
  );
}
