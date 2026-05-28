// FAQ アコーディオン。<details> ベースで JS 不要 (Server Component)。

import { getTranslations } from 'next-intl/server';
import { ChevronDown } from 'lucide-react';

const QA = [
  { q: 'faqQ1', a: 'faqA1' },
  { q: 'faqQ2', a: 'faqA2' },
  { q: 'faqQ3', a: 'faqA3' },
  { q: 'faqQ4', a: 'faqA4' },
  { q: 'faqQ5', a: 'faqA5' },
] as const;

export async function LandingFaq() {
  const t = await getTranslations('Landing');

  return (
    <section className="mt-14">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {t('faqTitle')}
        </h2>
      </div>

      <ul className="mx-auto mt-6 max-w-3xl space-y-2">
        {QA.map(({ q, a }) => (
          <li key={q}>
            <details className="group rounded-2xl border border-slate-200 bg-white px-5 py-4 open:shadow-sm">
              <summary className="flex cursor-pointer list-none items-start gap-2 text-left text-sm font-semibold text-slate-800">
                <span className="flex-1">{t(q)}</span>
                <ChevronDown
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{t(a)}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
