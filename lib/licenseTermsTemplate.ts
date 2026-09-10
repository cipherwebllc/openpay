import type { Metadata } from 'next';
import { LEGAL_ENTITY } from '@/lib/legal';
import { LICENSE_STANDARD_TERMS } from '@/lib/license/standardTerms';

// Public wording DRAFT: user approval is required before merge/publication.
// After publication, preserve standard-v1; revisions require a new URL/version.
const JA = {
  title: `利用ライセンス標準条件 ${LICENSE_STANDARD_TERMS.version}`,
  description: 'OpenPay Store の出品者と購入者の間で適用される、利用ライセンス NFT の標準条件です。',
  languageNote: '購入時に記録する利用条件 URL は、この日本語ページです。英語ページは参考訳です。',
  canonicalLink: '日本語の利用条件',
  termsLink: 'OpenPay 利用規約（第13条）',
  items: [
    { title: '適用', body: `この条件は OpenPay Store で「標準条件」を選んで出品された利用ライセンス NFT 商品に適用され、出品者と購入者の間の契約条件です。${LEGAL_ENTITY.serviceName} (Cipher Web LLC) は第三者出品の契約当事者ではありません（利用規約第13条）。` },
    { title: '許諾範囲', body: '購入者本人が、商品説明に記載の対象物を、個人および商用の自己のプロジェクトで利用できます。商品説明に別段の記載があればそれが優先します。' },
    { title: '禁止事項', body: '対象物そのものの再配布・転売・貸与・第三者への提供、および出品者の権利を侵害する利用は禁止します。' },
    { title: '期間', body: '無期限です。ただし出品者が提供を終了する場合は、OpenPay のライブラリで表示します。' },
    { title: 'NFT の扱い', body: '譲渡可否は商品設定に従います。譲渡可の商品では NFT の譲渡がライセンスの移転を伴い、元の保有者は行使できません。回数・残高はありません。' },
    { title: '発行', body: 'NFT は決済後、通常数分で支払いに使ったウォレットへ発行されます。発行が遅延・失敗しても購入に基づく権利は有効で、発行失敗への対応は購入後7日以内に出品者が行います。' },
    { title: '従量料金', body: 'ありません（別途従量課金がある場合は商品説明に明記します）。' },
    { title: '返金・救済', body: '商品が説明と著しく異なる場合など、利用規約第13条 (7) の救済は出品者と購入者の間で解決し、返金は出品者負担の別送金で行います。オンチェーン決済の取消はできません。' },
    { title: '配布', body: 'ファイルを外部配布先から配布する商品では、配布先の運営と可用性は出品者の責任です（利用規約第13条 (18)）。' },
    { title: '連絡先', body: '購入画面の販売者情報に記載された連絡先へお問い合わせください。' },
    { title: 'バージョン', body: `${LICENSE_STANDARD_TERMS.version}（${LICENSE_STANDARD_TERMS.date}）です。この条件は改定されず、改定時は新しいバージョンの URL を発行します。` },
  ],
};

const EN: typeof JA = {
  title: `Standard Usage License Terms ${LICENSE_STANDARD_TERMS.version}`,
  description: 'Standard terms for usage license NFTs between sellers and buyers on OpenPay Store.',
  languageNote: 'This English page is a reference translation; the terms URL recorded at purchase is the Japanese page.',
  canonicalLink: 'Japanese license terms',
  termsLink: 'OpenPay Terms of Service (Article 13)',
  items: [
    { title: 'Application', body: `These terms apply to usage license NFT products listed on OpenPay Store with “Standard terms” selected and form the contract between the seller and buyer. ${LEGAL_ENTITY.serviceName} (Cipher Web LLC) is not a party to contracts for third-party listings (Terms of Service, Article 13).` },
    { title: 'Scope of permission', body: 'The buyer may use the subject matter identified in the product description in their own personal and commercial projects. Any different provisions in the product description take precedence.' },
    { title: 'Prohibited uses', body: 'Redistributing, reselling, lending or providing the subject matter itself to third parties, and uses that infringe the seller’s rights, are prohibited.' },
    { title: 'Duration', body: 'The license has no expiry. If the seller ends provision, a notice will appear in the OpenPay library.' },
    { title: 'NFT handling', body: 'Transferability follows the product settings. For transferable products, transferring the NFT also transfers the license, and the former holder can no longer exercise it. There are no usage counts or balances.' },
    { title: 'Issuance', body: 'The NFT is usually issued to the wallet used for payment within a few minutes after payment. Purchase rights remain valid if issuance is delayed or fails. The seller will address issuance failures within 7 days of purchase.' },
    { title: 'Metered charges', body: 'There are none (any separate metered charges will be stated in the product description).' },
    { title: 'Refunds and remedies', body: 'Remedies under Article 13 (7) of the Terms of Service, including where a product differs materially from its description, are resolved between the seller and buyer. Refunds are separate transfers funded by the seller. On-chain payments cannot be reversed.' },
    { title: 'Delivery', body: 'For products whose files are delivered from an external destination, the seller is responsible for operating that destination and for its availability (Terms of Service, Article 13 (18)).' },
    { title: 'Contact', body: 'Please use the contact details in the seller information on the purchase screen.' },
    { title: 'Version', body: `${LICENSE_STANDARD_TERMS.version} (${LICENSE_STANDARD_TERMS.date}). These terms will not be amended; any revision will be published at a new version URL.` },
  ],
};

export function licenseTermsTemplateContentFor(locale: string) {
  return locale === 'en' ? EN : JA;
}

export function licenseTermsTemplateMetadata(locale: string): Metadata {
  const c = licenseTermsTemplateContentFor(locale);
  return {
    title: `${c.title} | ${LEGAL_ENTITY.serviceName}`,
    description: c.description,
    alternates: {
      canonical: LICENSE_STANDARD_TERMS.url,
      languages: {
        ja: LICENSE_STANDARD_TERMS.url,
        en: `${LEGAL_ENTITY.siteUrl}/en${LICENSE_STANDARD_TERMS.path}`,
      },
    },
    robots: { index: true, follow: true },
  };
}
