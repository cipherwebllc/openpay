// プライバシーポリシー page。namespace 'Privacy' 内の section1..section7 を render。
// 個情法 28 条 (越境移転)・APPI 33-35 条 (開示等請求) を踏まえた構成。
// 委託先 (Vercel/Pimlico/Alchemy)・連絡先は lib/legal.ts から注入。

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LEGAL_ENTITY } from '@/lib/legal';

export default function PrivacyPage() {
  const t = useTranslations('Privacy');
  const introPlaceholders = {
    company: LEGAL_ENTITY.companyName,
    service: LEGAL_ENTITY.serviceName,
  };
  const contactPlaceholders = {
    company: LEGAL_ENTITY.companyName,
    address: LEGAL_ENTITY.headOffice,
    representative: LEGAL_ENTITY.representative,
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
            {t('effectiveDate', { date: LEGAL_ENTITY.privacyEffectiveDate })}
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
        <Section
          title={t('section6.title')}
          body={t('section6.body', contactPlaceholders)}
        />
        <Section title={t('section7.title')} body={t('section7.body')} />

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
