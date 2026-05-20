'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { QrGenerator } from '@/components/QrGenerator';
import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import type { Locale } from '@/i18n';
import { env } from '@/lib/env';
import { getExchangeLink } from '@/lib/links';
import { TOKEN_SYMBOLS } from '@/lib/tokens';

type Tab = 'qr' | 'tip';

export default function HomePage() {
  const [tab, setTab] = useState<Tab>('qr');
  const t = useTranslations('Home');
  const tScan = useTranslations('Scan');
  const locale = useLocale() as Locale;

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-slate-500">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <LocaleSwitcher />
          <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">
            {env.networkEnv}
          </span>
        </div>
      </header>

      {/* Phase 1 experimental: 「事前接続して、レジで scan → sign」UX の入り口。
          仮説検証期間中 (memory: feedback_demand_first.md)、demand-gated で
          home からの 1 動線のみ提供する。需要 signal が出なければ rollback 容易。 */}
      <Link
        href={`/${locale}/scan`}
        prefetch={false}
        className="mb-4 block rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 transition hover:border-blue-300 hover:bg-blue-100 print:hidden"
      >
        <p className="text-sm font-semibold text-blue-900">
          {tScan('homeCta.title')}
        </p>
        <p className="mt-1 text-xs text-blue-800">
          {tScan('homeCta.body')}
        </p>
        <span className="mt-2 inline-block rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white">
          {tScan('homeCta.button')} →
        </span>
      </Link>

      <div className="mb-4 inline-flex flex-wrap rounded-xl border border-slate-200 bg-slate-100 p-1 print:hidden">
        {(
          [
            ['qr', t('tabs.qr')],
            ['tip', t('tabs.tip')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              tab === id
                ? 'bg-white text-brand-dark shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {tab === 'qr' ? (
          <QrGenerator />
        ) : (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">
                {t('tipPanel.heading')}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {t('tipPanel.subheading')}
              </p>
            </div>
            <TipEmbedGenerator />
          </div>
        )}
      </div>

      <section
        aria-labelledby="offramp-heading"
        className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 print:hidden"
      >
        <h2
          id="offramp-heading"
          className="text-base font-semibold text-slate-800"
        >
          {t('offramp.heading')}
        </h2>
        <p className="mt-1 text-xs text-slate-500">{t('offramp.subheading')}</p>
        <ul className="mt-3 space-y-2">
          {TOKEN_SYMBOLS.map((token) => {
            const link = getExchangeLink(token, locale);
            return (
              <li
                key={token}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
              >
                <span className="text-slate-700">
                  {t('offramp.row', { token: token.toUpperCase() })}
                </span>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand hover:underline"
                >
                  {link.label} ↗
                </a>
                {link.jaResidentsOnly && (
                  <span className="text-xs text-slate-500">
                    {t('offramp.jaResidentsOnlyNote')}
                  </span>
                )}
                {link.blocksJapaneseResidents && (
                  <span className="text-xs text-slate-500">
                    {t('offramp.japaneseUserHint')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-slate-400">{t('offramp.hint')}</p>
      </section>

    </main>
  );
}
