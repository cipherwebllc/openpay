// 免責事項 page。namespace 'Disclaimer' 内の section1..section6 を render。
// 現状有姿提供・取消不能・第三者発行 token・gas 変動・第三者サービス障害・
// 法令変更を網羅。利用規約と一体運用 (法的に上位は Terms)。

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LEGAL_ENTITY } from '@/lib/legal';

export default function DisclaimerPage() {
  const t = useTranslations('Disclaimer');
  const introPlaceholders = {
    company: LEGAL_ENTITY.companyName,
    service: LEGAL_ENTITY.serviceName,
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
            {t('effectiveDate', { date: LEGAL_ENTITY.disclaimerEffectiveDate })}
          </p>
        </div>

        <p className="whitespace-pre-line text-sm leading-relaxed">
          {t('intro', introPlaceholders)}
        </p>

        <Section title={t('section1.title')} body={t('section1.body')} />
        <Section title={t('section2.title')} body={t('section2.body')} />
        <Section title={t('section3.title')} body={t('section3.body')} />
        <Section title={t('section4.title')} body={t('section4.body')} />
        <Section title={t('section5.title')} body={t('section5.body')} />
        <Section title={t('section6.title')} body={t('section6.body')} />

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
