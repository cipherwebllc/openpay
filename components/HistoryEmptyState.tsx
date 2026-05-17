'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function HistoryEmptyState() {
  const t = useTranslations('History');
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-700">{t('empty')}</p>
      <p className="mt-1 text-xs text-slate-500">{t('emptyHint')}</p>
      <Link
        href="/"
        prefetch={false}
        className="mt-4 inline-block rounded-full bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-dark"
      >
        OpenPay →
      </Link>
    </div>
  );
}
