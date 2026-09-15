import type { Metadata } from 'next';

export const DIRECTORY_LICENSE = {
  id: 'openpay-directory-license-v1',
  name: 'OpenPay Directory Data License v1',
  version: 'directory-v1',
  urlFor: (locale: string) => `https://open-pay.jp/${locale === 'en' ? 'en' : 'ja'}/license-terms/directory-v1`,
} as const;

export const DIRECTORY_LICENSE_PERMISSIONS = {
  grants: ['Commercial and non-commercial use', 'Use in services, analyses, AI-agent responses and derivative works', 'Redistribution of derived facts'],
  requires: ['Attribution to OpenPay Japan Web3 Directory and the cited official sources'],
  prohibits: ['Resale or redistribution as-is or in substantially the same form', 'Presenting records as source endorsements or guarantees', 'Infringement of source owners’ rights'],
} as const;

// Public wording draft from plans/usdc-premium-products.md; approval is required before merge.
const JA = {
  title: DIRECTORY_LICENSE.name,
  description: 'Japan Web3 Directory ライセンス版エクスポートの利用条件。',
  termsLink: 'OpenPay 利用規約',
  items: [
    { title: '対象', body: '本ライセンスは、OpenPay が提供する Japan Web3 Directory のライセンス版エクスポート (以下「本データ」) に適用されます。本データは公式ソースの要約であり、各記載の権利は出典元に帰属します。' },
    { title: '許諾', body: '購入者は、本データを自社のサービス・分析・AI エージェントの応答・派生成果物に、商用・非商用を問わず利用できます。派生した事実の再配布も許諾します。' },
    { title: '帰属表示', body: '本データまたはその派生物を第三者に提供する場合、「Source: OpenPay Japan Web3 Directory (open-pay.jp) and the cited official sources」相当の帰属表示を含めてください。' },
    { title: '禁止', body: '本データをそのまま (実質的に同一の形で) 再販・再配布すること。本データの記載を出典元の保証・推奨として表示すること。出典元の権利を侵害する利用。' },
    { title: '保証の否認', body: '本データは「現状有姿」で提供され、正確性・完全性・特定目的適合性を保証しません。利用前に各出典で最新情報を確認してください。' },
    { title: '証明', body: '応答に含まれる署名 (attestation) は、OpenPay が当該内容・購入者アドレス・発行時刻を発行した事実を示すもので、法的な効力や第三者による認証を意味しません。' },
    { title: '期間・変更', body: '許諾は購入した時点のデータに対して無期限です。条件の変更は新しいバージョン (URL) で行い、既購入分には遡及しません。' },
    { title: '準拠法', body: '日本法。OpenPay 利用規約が優先して適用されます。' },
  ],
};

const EN = {
  title: DIRECTORY_LICENSE.name,
  description: 'Terms for the Japan Web3 Directory Licensed Export.',
  termsLink: 'OpenPay Terms of Service',
  items: [
    { title: 'Scope', body: 'This license applies to the Licensed Export of the Japan Web3 Directory provided by OpenPay (the "Data"). The Data summarizes official sources; rights in each record remain with the source owners.' },
    { title: 'Grant', body: 'You may use the Data in your services, analyses, AI-agent responses and derivative works, commercially or not, and redistribute derived facts.' },
    { title: 'Attribution', body: 'When you provide the Data or derivatives to third parties, include an attribution equivalent to "Source: OpenPay Japan Web3 Directory (open-pay.jp) and the cited official sources".' },
    { title: 'Restrictions', body: 'No resale or redistribution of the Data as-is (or in substantially the same form). Do not present records as endorsements or guarantees by the sources. No use that infringes the source owners\' rights.' },
    { title: 'Disclaimer', body: 'The Data is provided "as is" without warranty of accuracy, completeness or fitness for a particular purpose. Verify current details with each cited source before relying on them.' },
    { title: 'Attestation', body: 'The signature included in the response shows only that OpenPay issued this content to the stated buyer address at the stated time; it is not a legal certification or third-party verification.' },
    { title: 'Term and changes', body: 'The grant is perpetual for the Data as purchased. Changes are made through a new version (URL) and do not apply retroactively.' },
    { title: 'Governing law', body: 'Japan. The OpenPay Terms of Service prevail.' },
  ],
};

export function directoryLicenseContentFor(locale: string) {
  return locale === 'en' ? EN : JA;
}

export function directoryLicenseMetadata(locale: string): Metadata {
  const c = directoryLicenseContentFor(locale);
  return {
    title: `${c.title} | OpenPay`,
    description: c.description,
    alternates: {
      canonical: DIRECTORY_LICENSE.urlFor(locale),
      languages: { ja: DIRECTORY_LICENSE.urlFor('ja'), en: DIRECTORY_LICENSE.urlFor('en') },
    },
    robots: { index: true, follow: true },
  };
}
