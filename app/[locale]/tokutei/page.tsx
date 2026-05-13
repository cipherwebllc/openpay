'use client';

import { useTranslations } from 'next-intl';
import { LegalPageShell } from '@/components/LegalPageShell';
import { LEGAL_ENTITY } from '@/lib/legal';

const ROW_KEYS = [
  'seller',
  'manager',
  'address',
  'phone',
  'email',
  'url',
  'serviceContent',
  'supportedTokens',
  'price',
  'additionalFees',
  'serviceStartTiming',
  'paymentTiming',
  'returnPolicy',
  'environment',
] as const;

export default function TokuteiPage() {
  const t = useTranslations('Tokutei');
  const placeholders = {
    company: LEGAL_ENTITY.companyName,
    service: LEGAL_ENTITY.serviceName,
    corporateNumber: LEGAL_ENTITY.corporateNumber,
    representative: LEGAL_ENTITY.representative,
    address: LEGAL_ENTITY.headOffice,
    email: LEGAL_ENTITY.contactEmail,
    url: LEGAL_ENTITY.siteUrl,
  };

  return (
    <LegalPageShell
      title={t('title')}
      effectiveDate={t('effectiveDate', {
        date: LEGAL_ENTITY.tokuteiEffectiveDate,
      })}
      intro={t('intro', placeholders)}
      legalNote={t('legalNote')}
    >
      <dl className="divide-y divide-slate-200 border-y border-slate-200 text-sm">
        {ROW_KEYS.map((key) => (
          <div
            key={key}
            className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4"
          >
            <dt className="font-semibold text-slate-900">
              {t(`rows.${key}.label`)}
            </dt>
            <dd className="whitespace-pre-line leading-relaxed text-slate-700">
              {t(`rows.${key}.value`, placeholders)}
            </dd>
          </div>
        ))}
      </dl>
    </LegalPageShell>
  );
}
