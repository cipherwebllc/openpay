'use client';

import { useTranslations } from 'next-intl';
import type { StoredOrder } from '@/lib/orderRelay';

export function OrderBindingNotice({ order }: { order: StoredOrder }) {
  const t = useTranslations('OrderBinding');
  if (order.bindingMissing) {
    return <p role="alert" className="my-2 rounded-lg border-2 border-red-600 bg-red-50 p-3 font-sans text-sm font-bold tracking-normal text-red-900">{t('unverified')}</p>;
  }
  return null;
}

export function OrderBindingScope() {
  const t = useTranslations('OrderBinding');
  return <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-800">{t('scope')}</p>;
}
