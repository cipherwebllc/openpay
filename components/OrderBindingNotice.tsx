'use client';

import { useTranslations } from 'next-intl';
import type { StoredOrder } from '@/lib/orderRelay';

export function OrderBindingNotice({ order }: { order: StoredOrder }) {
  const t = useTranslations('OrderBinding');
  if (order.bindingMissing) {
    return <p role="alert" className="my-2 rounded-lg border-2 border-red-600 bg-red-50 p-3 font-sans text-sm font-bold tracking-normal text-red-900">{t('unverified')}</p>;
  }
  // 通常の送金など、支払いと注文内容を結びつけられない経路で届いた注文 (A2c で受容した残余)。金額は検証済みなので
  // 警告ではなく、受け渡しのときの確認を促す注記にする。この注記が無い注文は結びつきを確かめ済み。
  if (order.unboundPayment) {
    return <p className="my-2 rounded-lg bg-amber-50 px-3 py-2 font-sans text-xs font-medium tracking-normal text-amber-900 ring-1 ring-amber-200">{t('unboundPayment')}</p>;
  }
  return null;
}
