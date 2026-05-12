// 利用規約 page。i18n namespace 'Terms' 内の article1..article11 を順に render。
// non-custodial 性質・料金体系・取消不能・準拠法を明示。本文は messages/*.json で
// 管理する。文面は弁護士 review 前の draft であり、{company} 等の placeholder は
// lib/legal.ts の LEGAL_ENTITY から注入する。

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LEGAL_ENTITY } from '@/lib/legal';

export default function TermsPage() {
  const t = useTranslations('Terms');
  const placeholders = {
    company: LEGAL_ENTITY.companyName,
    service: LEGAL_ENTITY.serviceName,
    email: LEGAL_ENTITY.contactEmail,
  };

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
            {t('title')}
          </h1>
          <p className="mt-2 text-xs text-slate-500">
            {t('effectiveDate', { date: LEGAL_ENTITY.termsEffectiveDate })}
          </p>
        </div>

        <p className="whitespace-pre-line text-sm leading-relaxed">
          {t('intro', placeholders)}
        </p>

        <Section title={t('article1.title')} body={t('article1.body')} />
        <Section title={t('article2.title')} body={t('article2.body')} />
        <Section title={t('article3.title')} body={t('article3.body')} />
        <Section title={t('article4.title')} body={t('article4.body')} />
        <Section title={t('article5.title')} body={t('article5.body')} />
        <Section title={t('article6.title')} body={t('article6.body')} />
        <Section title={t('article7.title')} body={t('article7.body')} />
        <Section title={t('article8.title')} body={t('article8.body')} />
        <Section title={t('article9.title')} body={t('article9.body')} />
        <Section title={t('article10.title')} body={t('article10.body')} />
        <Section title={t('article11.title')} body={t('article11.body')} />

        <p className="text-sm leading-relaxed">
          {t('contact', { email: LEGAL_ENTITY.contactEmail })}
        </p>

        <div className="border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
          <p>{LEGAL_ENTITY.companyName}</p>
          <p>{t('legalNote')}</p>
        </div>
      </article>
    </main>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <h2 className="mb-1.5 text-base font-semibold text-slate-900">{title}</h2>
      <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">
        {body}
      </p>
    </section>
  );
}
