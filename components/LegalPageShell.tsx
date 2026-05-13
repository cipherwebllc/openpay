'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { LEGAL_ENTITY } from '@/lib/legal';

export function LegalPageShell({
  title,
  effectiveDate,
  intro,
  children,
  legalNote,
}: {
  title: string;
  effectiveDate: string;
  intro?: ReactNode;
  children: ReactNode;
  legalNote: string;
}) {
  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-8 sm:py-12">
      <header className="mb-6 flex items-center justify-between text-xs text-slate-500">
        <Link href="/" className="hover:text-slate-700" prefetch={false}>
          ← OpenPay
        </Link>
      </header>

      <article className="space-y-6 text-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {title}
          </h1>
          <p className="mt-2 text-xs text-slate-500">{effectiveDate}</p>
        </div>

        {intro && (
          <p className="whitespace-pre-line text-sm leading-relaxed">{intro}</p>
        )}

        {children}

        <div className="border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
          <p>{LEGAL_ENTITY.companyName}</p>
          <p>{legalNote}</p>
        </div>
      </article>
    </main>
  );
}

export function LegalSection({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <h2 className="mb-1.5 text-base font-semibold text-slate-900">{title}</h2>
      <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">
        {body}
      </p>
    </section>
  );
}
