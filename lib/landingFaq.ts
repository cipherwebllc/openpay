// トップの FAQ の並び (表示 components/LandingFaq.tsx と構造化データ components/StructuredData.tsx の単一情報源)。
// 構造化データ (FAQPage) は画面に見えている Q&A と一致させる (検索エンジンの指針・AI の引用元)。
// 番号は歴史的経緯のまま (faqQ6「利用料」は「利用料について」の節へ移して廃止・2026-09-28)。
export const LANDING_FAQ = [
  { q: 'faqQ1', a: 'faqA1' },
  // 「JPYC・USDC とは」= 基礎説明。「どちらを受け取るか (faqQ2)」の直前に置く。
  { q: 'faqQ7', a: 'faqA7' },
  { q: 'faqQ2', a: 'faqA2' },
  { q: 'faqQ3', a: 'faqA3' },
  { q: 'faqQ4', a: 'faqA4' },
  { q: 'faqQ5', a: 'faqA5' },
  // B2B 請求 (開発費/保守費) の利用例 — Mi&T の法人 JPYC 受付 (2026-07-27) を受けた
  // 訴求拡張 (user 承認 2026-07-30)。新機能の約束はせず既存の決済リンクの説明のみ。
  { q: 'faqQ8', a: 'faqA8' },
] as const;

export type LandingFaqAnswerKey = (typeof LANDING_FAQ)[number]['a'];
