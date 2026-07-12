'use client';

import { useTranslations } from 'next-intl';
import { useNewOrderFlash } from '@/hooks/useNewOrderFlash';
import type { StoredCall } from '@/lib/orderRelay';

export function OrderCallSection({
  calls,
  subject,
  enabled,
  isLoading,
  isError,
  isPending,
  onResolve,
  onNewCalls,
}: {
  calls: StoredCall[];
  subject: string | null | undefined;
  enabled: boolean;
  isLoading: boolean;
  isError: boolean;
  isPending: boolean;
  onResolve: (id: string) => void;
  onNewCalls?: () => void;
}) {
  const t = useTranslations('OrderCall');
  const flashing = useNewOrderFlash(
    calls.map((call) => call.id),
    subject,
    { enabled, onNewOrders: onNewCalls },
  );

  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50/60 p-3">
      <h2 className="text-sm font-bold text-amber-900">{t('heading')}</h2>
      {isError ? (
        <p className="mt-2 text-xs text-amber-800">{t('loadError')}</p>
      ) : isLoading ? (
        <p className="mt-2 text-xs text-amber-700">{t('loading')}</p>
      ) : calls.length === 0 ? (
        <p className="mt-2 text-xs text-amber-700">{t('empty')}</p>
      ) : (
        <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {calls.map((call) => {
            const age = Math.max(0, Math.floor((Date.now() - call.ts) / 60_000));
            return (
              <li
                key={call.id}
                className={`rounded-xl border bg-white p-3 ${
                  flashing.has(call.id)
                    ? 'animate-pulse border-amber-500 ring-2 ring-amber-300'
                    : 'border-amber-200'
                }`}
              >
                <p className="font-bold text-slate-900">🔔 {t('table', { table: call.table })}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">{t('minutesAgo', { m: age })}</span>
                  <button
                    type="button"
                    onClick={() => onResolve(call.id)}
                    disabled={isPending}
                    className="rounded-lg border border-amber-400 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-50"
                  >
                    {t('done')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
