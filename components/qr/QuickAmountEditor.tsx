'use client';

import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';

// よく使う金額の編集欄 (金額カードの「編集」で開く・2026-10 磨き上げ P2 で折りたたみから切替式に)。
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
    <div className="mt-3 space-y-2 rounded-xl bg-slate-50 p-3">
      {items.map((q, i) => (
        <div key={i} className="flex gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={q}
            onChange={(e) => onUpdate(i, e.target.value)}
            placeholder={t('quickAmountPlaceholder')}
            aria-label={t('quickAmountPlaceholder')}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm tabular-nums focus:border-brand focus:outline-none"
          />
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{t('quickAmountRemove')}</span>
          </button>
        </div>
      ))}
      {items.length < max && (
        <button
          type="button"
          onClick={onAdd}
          className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
        >
          {t('quickAmountAdd')}
        </button>
      )}
    </div>
  );
}
