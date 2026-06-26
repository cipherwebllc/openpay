'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Receipt, ArrowRight } from 'lucide-react';

export function HistoryEmptyState() {
  const t = useTranslations('History');
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-card">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/5 text-brand">
        <Receipt className="h-7 w-7" aria-hidden />
      </span>
      <p className="mt-4 text-base font-semibold text-slate-800">{t('empty')}</p>
      <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-slate-500">
        {t('emptyHint')}
      </p>
      <Link
        href="/"
        prefetch={false}
        className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-brand-dark hover:shadow-card-hover active:translate-y-0"
      >
        OpenPay
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}
