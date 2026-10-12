'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { LegalPageShell } from '@/components/LegalPageShell';
import { LEGAL_ENTITY, cctpFeeDisclosureValues } from '@/lib/legal';

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
  const locale = useLocale();
  const placeholders = {
    company: LEGAL_ENTITY.companyName,
    service: LEGAL_ENTITY.serviceName,
    corporateNumber: LEGAL_ENTITY.corporateNumber,
    representative: LEGAL_ENTITY.representative,
    address: LEGAL_ENTITY.headOffice,
    email: LEGAL_ENTITY.contactEmail,
    url: LEGAL_ENTITY.siteUrl,
    // 「対価以外の費用」の Circle の転送手数料の上限 (lib/legal.ts の DISCLOSED_CCTP_FEE)。
    ...cctpFeeDisclosureValues(),
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
              {/* 役務の対価の下に、機能ごとの料金と計算例 (/pricing) への 1 行 (plans/pricing-page.md §2.6)。
                  法定表示の本文 (rows.price.value) と施行日は変えない (リンクの追加だけ)。
                  リンク名は可視テキスト (掟 8)・min-h-11 で tap target 44px。 */}
              {key === 'price' && (
                <span className="mt-2 block">
                  {t.rich('priceSeeAlso', {
                    link: (chunks) => (
                      <Link
                        href={`/${locale}/pricing`}
                        prefetch={false}
                        className="inline-flex min-h-11 items-center font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </LegalPageShell>
  );
}
