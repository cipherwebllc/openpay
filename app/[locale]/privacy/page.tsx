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
      {/* Web Push 通知 (任意): 保管期間 (4) と安全管理措置 (6) の間に配置。表示番号は「5.」。 */}
      <LegalSection
        title={t('sectionPush.title')}
        body={t('sectionPush.body')}
      />
      {/* 安全管理措置 (個情法対応): 保管期間 (4) と開示請求 (7) の間に配置。
          i18n key は sectionSecurity だが表示番号は「6.」(以降を 7/8/9 へ繰下げ)。 */}
      <LegalSection
        title={t('sectionSecurity.title')}
        body={t('sectionSecurity.body')}
      />
      <LegalSection title={t('section5.title')} body={t('section5.body')} />
      <LegalSection
        title={t('section6.title')}
        body={t('section6.body', contactPlaceholders)}
      />
      <LegalSection title={t('section7.title')} body={t('section7.body')} />
    </LegalPageShell>
  );
}
