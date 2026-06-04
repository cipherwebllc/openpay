'use client';

// 決済完了画面 (PaymentForm / CheckoutForm / TipForm) に、たった今保存された顧客向け
// 電子レシート (支払い控え) を埋め込む。receiptId(=txHash||userOpHash) で LocalStorage の
// 控えを引き、PayerReceiptDetail (コピー/印刷/JSON/CSV) + /scan 導線を出す。
//
// 保存は usePaymentHistory / TipForm の成功 effect 側で行われ、本コンポーネントは購読して
// 描画するだけ。未保存 (pending で txHash 未確定 等) の間は何も出さない (graceful)。

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePayerReceipts } from '@/hooks/usePayerReceipts';
import { PayerReceiptDetail } from './PayerReceiptDetail';

export function PayerReceiptCompletion({
  candidateIds,
}: {
  /** 控え検索キー候補 (txHash / userOpHash 等)。最初に一致した控えを表示。 */
  candidateIds: Array<string | null | undefined>;
}) {
  const t = useTranslations('PayerReceipt');
  const { receipts, hydrated } = usePayerReceipts();

  if (!hydrated) return null;
  const ids = candidateIds.filter((v): v is string => !!v);
  const receipt = receipts.find((r) => ids.includes(r.receiptId));
  if (!receipt) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-slate-700">
        {t('completionTitle')}
      </p>
      <PayerReceiptDetail receipt={receipt} />
      <Link
        href="/scan"
        prefetch={false}
        className="inline-block text-xs text-brand underline underline-offset-2 hover:opacity-80"
      >
        {t('scanLink')}
      </Link>
    </div>
  );
}
