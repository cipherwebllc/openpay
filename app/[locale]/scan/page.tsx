'use client';

import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/AppShell';
import { ScanShell } from '@/components/ScanShell';

export default function ScanPage() {
  const t = useTranslations('Scan');
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5">
          <h2 className="text-xl font-bold text-slate-900">{t('pageTitle')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('pageSubtitle')}</p>
        </div>
        <ScanShell />
      </div>
    </AppShell>
  );
}
