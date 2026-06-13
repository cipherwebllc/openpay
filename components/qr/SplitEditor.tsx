'use client';

import { useTranslations } from 'next-intl';
import { type SplitDraft } from '@/lib/url';
import { Field } from '../Field';

export function SplitEditor({
  splits,
  max,
  sum,
  error,
  summaryCount,
  onUpdate,
  onAdd,
  onRemove,
}: {
  splits: SplitDraft[];
  max: number;
  sum: number;
  error: 'addr' | 'pct' | 'sum' | 'dup' | null;
  summaryCount: number | null;
  onUpdate: (idx: number, patch: Partial<SplitDraft>) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  const t = useTranslations('QrGenerator');
  return (
    <Field
      label={t('splitLabel', {
        primaryPercent: 100 - sum,
      })}
    >
      <p className="mb-2 text-xs text-slate-500">
        {t('splitDescription', { max })}
      </p>
      <div className="space-y-2">
        {splits.map((s, i) => (
          <div key={i} className="flex flex-wrap items-start gap-2">
            <input
              type="text"
              value={s.address}
              onChange={(e) =>
                onUpdate(i, { address: e.target.value.trim() })
              }
              placeholder="0x..."
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand focus:outline-none"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <input
              type="text"
              inputMode="numeric"
              value={s.percent}
              onChange={(e) =>
                onUpdate(i, {
                  percent: e.target.value.replace(/[^\d]/g, ''),
                })
              }
              placeholder="%"
              className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-2 text-center text-sm focus:border-brand focus:outline-none"
              maxLength={2}
              aria-label={t('splitPercentLabel')}
            />
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={t('splitRemove')}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-600"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {splits.length < max && (
        <button
          type="button"
          onClick={onAdd}
          className="mt-2 rounded-md border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-brand hover:text-brand-dark"
        >
          {t('splitAdd')}
        </button>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600">
          {t(`splitError.${error}`)}
        </p>
      )}
      {summaryCount !== null && summaryCount > 0 && (
        <p className="mt-2 text-xs text-emerald-700">
          {t('splitSummary', {
            count: summaryCount,
            primaryPercent: 100 - sum,
          })}
        </p>
      )}
    </Field>
  );
}
