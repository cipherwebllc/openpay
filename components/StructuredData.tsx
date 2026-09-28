// SEO/AIEO: LP に JSON-LD (schema.org) を埋め込む Server Component。
// - SoftwareApplication: OpenPay のエンティティ定義 (AI 引用/ナレッジパネルの素)
// - FAQPage: LP に見えている FAQ (lib/landingFaq.ts の並び) をそのまま構造化 — 文言の単一情報源は messages。
//   回答は画面と同じ値で差し込み値を埋め、タグは中身の文字だけにする (穴あきの料率や生のタグを出さない)。
// 表示 UI は持たない (head/body どちらでも valid・LP page から render)。
import { getLocale, getTranslations } from 'next-intl/server';
import { LANDING_PAYMENT_FEE_VALUES } from '@/lib/legal';
import { LANDING_FAQ } from '@/lib/landingFaq';

export const SITE_URL = 'https://open-pay.jp';

// <script> 内 JSON の `<` を < にエスケープ。将来 messages の文言に
// "</script>" 相当が紛れても script 文脈脱出 (XSS) に波及させないための防御
// (JSON.stringify は < を escape しない・Next.js 本体と同じ手当て)。
function safeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * 任意の JSON-LD を安全に埋め込む汎用 Server/Client 兼用 component。
 * escape は safeJsonLd に一本化 (script 文脈脱出の遮断を 1 箇所に保つ)。
 */
export function JsonLd({ value }: { value: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJsonLd(value) }}
    />
  );
}

export async function StructuredData() {
  const locale = await getLocale();
  const meta = await getTranslations('Meta');
  const landing = await getTranslations('Landing');

  const softwareApplication = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'OpenPay',
    url: SITE_URL,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Web',
    description: meta('description'),
    inLanguage: locale,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'JPY' },
  };

  const faqPage = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: LANDING_FAQ.map(({ q, a }) => ({
      '@type': 'Question',
      name: landing(q),
      acceptedAnswer: {
        '@type': 'Answer',
        // 表示 (LandingFaq) と同じ値で埋める。リンクのタグ (faqA4 の <jpycEx>・<create>) は中身の文字だけにする。
        text: landing.markup(a, { ...LANDING_PAYMENT_FEE_VALUES, jpycEx: (chunks) => chunks, create: (chunks) => chunks }),
      },
    })),
  };

  return (
    <>
      <JsonLd value={softwareApplication} />
      <JsonLd value={faqPage} />
    </>
  );
}
