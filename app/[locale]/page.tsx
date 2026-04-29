'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { QrGenerator } from '@/components/QrGenerator';
import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import { CheckoutLinkGenerator } from '@/components/CheckoutLinkGenerator';
import { env } from '@/lib/env';

type Tab = 'qr' | 'checkout' | 'tip';

export default function HomePage() {
  const [tab, setTab] = useState<Tab>('qr');
  const t = useTranslations('Home');

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
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
          <Link href="/pay" className="text-brand hover:underline" prefetch={false}>
            {t('linkPay')}
          </Link>
        </div>
      </header>

      <div className="mb-4 inline-flex flex-wrap rounded-xl border border-slate-200 bg-slate-100 p-1">
        {(
          [
            ['qr', t('tabs.qr')],
            ['checkout', t('tabs.checkout')],
            ['tip', t('tabs.tip')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id as Tab)}
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

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        {tab === 'qr' ? (
          <QrGenerator />
        ) : tab === 'checkout' ? (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">
                {t('checkoutPanel.heading')}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                {t('checkoutPanel.subheading')}
              </p>
            </div>
            <CheckoutLinkGenerator />
          </div>
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

      <footer className="mt-8 text-center text-xs text-slate-400">
        {t('footer')}
      </footer>
    </main>
  );
}
