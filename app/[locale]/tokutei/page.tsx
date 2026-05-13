// 特定商取引法に基づく表記 page。i18n namespace 'Tokutei' を label / value の
// 2 列 (definition list 風) で render する。電話番号は施行規則 23 条 1 項 2 号
// の exception を採用 (本ページで省略、請求あり次第遅滞なく開示) 。

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
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
  const sharedPlaceholders = {
    company: LEGAL_ENTITY.companyName,
    service: LEGAL_ENTITY.serviceName,
    corporateNumber: LEGAL_ENTITY.corporateNumber,
    representative: LEGAL_ENTITY.representative,
    address: LEGAL_ENTITY.headOffice,
    email: LEGAL_ENTITY.contactEmail,
    url: LEGAL_ENTITY.siteUrl,
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
            {t('effectiveDate', { date: LEGAL_ENTITY.tokuteiEffectiveDate })}
          </p>
        </div>

        <p className="whitespace-pre-line text-sm leading-relaxed">
          {t('intro', sharedPlaceholders)}
        </p>

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
                {t(`rows.${key}.value`, sharedPlaceholders)}
              </dd>
            </div>
          ))}
        </dl>

        <div className="border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
          <p>{LEGAL_ENTITY.companyName}</p>
          <p>{t('legalNote')}</p>
        </div>
      </article>
    </main>
  );
}
