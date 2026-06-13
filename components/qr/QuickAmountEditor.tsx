'use client';

import { useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';

export function QuickAmountEditor({
  items,
  max,
  onUpdate,
  onAdd,
  onRemove,
}: {
  items: string[];
  max: number;
  onUpdate: (idx: number, value: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <details className="group rounded-2xl border border-slate-200 bg-white p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-slate-700">
        <span>{t('quickAmountsLabel')}</span>
        <ChevronRight
          className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90"
          aria-hidden
        />
      </summary>
      <div className="mt-3 space-y-2">
        {items.map((q, i) => (
          <div key={i} className="flex gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={q}
              onChange={(e) => onUpdate(i, e.target.value)}
              placeholder={t('quickAmountPlaceholder')}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={t('quickAmountRemove')}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
            >
              ×
            </button>
          </div>
        ))}
        {items.length < max && (
          <button
            type="button"
            onClick={onAdd}
            className="mt-1 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
          >
            {t('quickAmountAdd')}
          </button>
        )}
      </div>
    </details>
  );
}
