// 決済手段の変遷と、AI エージェントが支払う次の時代を示す。Server Component。

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Banknote, Bot, CreditCard, QrCode } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type EraStep = {
  Icon: LucideIcon;
  labelKey: 'aiEraCash' | 'aiEraCard' | 'aiEraQr' | 'aiEraAgent';
  current?: true;
};

const ERA_STEPS: readonly EraStep[] = [
  { Icon: Banknote, labelKey: 'aiEraCash' },
  { Icon: CreditCard, labelKey: 'aiEraCard' },
  { Icon: QrCode, labelKey: 'aiEraQr' },
  { Icon: Bot, labelKey: 'aiEraAgent', current: true },
];

export async function LandingAiAgents() {
  const locale = await getLocale();
  const t = await getTranslations('Landing');

  return (
    <section className="mt-24 sm:mt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-[1.75rem] font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {t('aiEraTitle')}
        </h2>
        <p className="mt-4 text-sm leading-relaxed text-slate-600 sm:text-base">
          {t('aiEraBody')}
        </p>
      </div>

      <ol className="mt-10 grid overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-card divide-y divide-slate-200 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        {ERA_STEPS.map(({ Icon, labelKey, current }) => (
          <li
            key={labelKey}
            className={`flex items-center gap-4 p-5 sm:min-h-44 sm:flex-col sm:justify-center sm:text-center ${
              current ? 'bg-blue-50/80' : ''
            }`}
          >
            <span
              className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl ${
                current ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              <Icon className="h-6 w-6" strokeWidth={1.75} aria-hidden />
            </span>
            <span className="flex flex-col items-start gap-1.5 sm:items-center">
              <span
                className={`text-sm font-semibold ${
                  current ? 'text-brand' : 'text-slate-700'
                }`}
              >
                {t(labelKey)}
              </span>
              {current ? (
                <span className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-brand">
                  {t('aiEraNow')}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          href={`/${locale}/discovery`}
          prefetch={false}
          className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 active:scale-[0.98] sm:w-auto"
        >
          {t('aiEraCtaStore')}
        </Link>
        <Link
          href={`/${locale}/guide/agent`}
          prefetch={false}
          className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:text-brand active:scale-[0.98] sm:w-auto"
        >
          {t('aiEraCtaGuide')}
        </Link>
        <Link
          href={`/${locale}/guide/sell`}
          prefetch={false}
          className="inline-flex w-full items-center justify-center whitespace-nowrap rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:text-brand active:scale-[0.98] sm:w-auto"
        >
          {t('aiEraCtaSell')}
        </Link>
      </div>
      {/* 売り手側の一言: 「実売済み」の証拠は /guide/sell が持つ (LP は控えめに 1 行だけ)。 */}
      <p className="mt-3 text-center text-xs text-slate-500">{t('aiEraSellNote')}</p>
    </section>
  );
}
