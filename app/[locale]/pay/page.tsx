'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { PaymentForm } from '@/components/PaymentForm';
import { env } from '@/lib/env';

export default function PayPage() {
  const t = useTranslations('PaymentForm');
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

      <Suspense
        fallback={
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
            {t('loading')}
          </div>
        }
      >
        <PaymentForm />
      </Suspense>
    </main>
  );
}
