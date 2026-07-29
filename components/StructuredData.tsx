// SEO/AIEO: LP に JSON-LD (schema.org) を埋め込む Server Component。
// - SoftwareApplication: OpenPay のエンティティ定義 (AI 引用/ナレッジパネルの素)
// - FAQPage: LP の FAQ (Landing.faqQ1..7) をそのまま構造化 — 文言の単一情報源は messages
// 表示 UI は持たない (head/body どちらでも valid・LP page から render)。
import { getLocale, getTranslations } from 'next-intl/server';

export const SITE_URL = 'https://open-pay.jp';
const FAQ_COUNT = 7;

// FAQ 回答の rich タグ (<jpycEx>…</jpycEx> 等) を落として平文化する。
// JSON-LD の text にマークアップを残すと検証エラー/引用劣化になるのを防ぐ。
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

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
    mainEntity: Array.from({ length: FAQ_COUNT }, (_, i) => ({
      '@type': 'Question',
      name: stripTags(landing.raw(`faqQ${i + 1}`) as string),
      acceptedAnswer: {
        '@type': 'Answer',
        text: stripTags(landing.raw(`faqA${i + 1}`) as string),
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
