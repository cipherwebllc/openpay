'use client';

import { useTranslations } from 'next-intl';
import { LegalPageShell, LegalSection } from '@/components/LegalPageShell';
import { LEGAL_ENTITY } from '@/lib/legal';

const ARTICLES = [
  'article1',
  'article2',
  'article3',
  'article4',
  'article5',
  'article6',
  'article7',
  'article8',
  'article9',
  'article10',
  'article11',
  'article12',
] as const;

export default function TermsPage() {
  const t = useTranslations('Terms');
  const placeholders = {
    company: LEGAL_ENTITY.companyName,
    service: LEGAL_ENTITY.serviceName,
    email: LEGAL_ENTITY.contactEmail,
  };
  // 賠償上限 (第9条) は lib/legal.ts の SoT を固定ロケールで 1 回整形し、ja/en の
  // 双方へ同一文字列として注入する (locale 間で表記が乖離しないことを構造保証)。
  const liabilityCap = LEGAL_ENTITY.liabilityCapJpy.toLocaleString('en-US');

  return (
    <LegalPageShell
      title={t('title')}
      effectiveDate={t('effectiveDate', { date: LEGAL_ENTITY.termsEffectiveDate })}
      intro={t('intro', placeholders)}
      legalNote={t('legalNote')}
    >
      {ARTICLES.map((k) => (
        <LegalSection
          key={k}
          title={t(`${k}.title`)}
          body={
            k === 'article9'
              ? t(`${k}.body`, { amount: liabilityCap })
              : t(`${k}.body`)
          }
        />
      ))}
      <p className="text-sm leading-relaxed">
        {t('contact', { email: LEGAL_ENTITY.contactEmail })}
      </p>
    </LegalPageShell>
  );
}
