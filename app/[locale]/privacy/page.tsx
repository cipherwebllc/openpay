'use client';

import { useTranslations } from 'next-intl';
import { LegalPageShell, LegalSection } from '@/components/LegalPageShell';
import { LEGAL_ENTITY } from '@/lib/legal';

export default function PrivacyPage() {
  const t = useTranslations('Privacy');
  const contactPlaceholders = {
    company: LEGAL_ENTITY.companyName,
    address: LEGAL_ENTITY.headOffice,
    representative: LEGAL_ENTITY.representative,
    email: LEGAL_ENTITY.contactEmail,
  };

  return (
    <LegalPageShell
      title={t('title')}
      effectiveDate={t('effectiveDate', {
        date: LEGAL_ENTITY.privacyEffectiveDate,
      })}
      intro={t('intro', {
        company: LEGAL_ENTITY.companyName,
        service: LEGAL_ENTITY.serviceName,
      })}
      legalNote={t('legalNote')}
    >
      <LegalSection title={t('section1.title')} body={t('section1.body')} />
      <LegalSection title={t('section2.title')} body={t('section2.body')} />
      <LegalSection title={t('section3.title')} body={t('section3.body')} />
      <LegalSection title={t('section4.title')} body={t('section4.body')} />
      <LegalSection title={t('section5.title')} body={t('section5.body')} />
      <LegalSection
        title={t('section6.title')}
        body={t('section6.body', contactPlaceholders)}
      />
      <LegalSection title={t('section7.title')} body={t('section7.body')} />
    </LegalPageShell>
  );
}
