'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { ScanShell } from '@/components/ScanShell';
import { env } from '@/lib/env';

export default function ScanPage() {
  const t = useTranslations('Scan');
  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 py-8 sm:py-10">
      <header className="mb-6 flex items-center justify-between gap-2 text-xs text-slate-500">
        <Link href="/" className="hover:text-slate-700" prefetch={false}>
          ← OpenPay
        </Link>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <span className="rounded-full bg-slate-200 px-2 py-1 font-mono">
            {env.networkEnv}
          </span>
        </div>
      </header>

      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">{t('pageTitle')}</h1>
        <p className="mt-1 text-sm text-slate-500">{t('pageSubtitle')}</p>
      </div>

      <ScanShell />
    </main>
  );
}
