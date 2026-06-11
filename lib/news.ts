// 運営からの一斉告知 (お知らせ) の単一 source of truth (SOT)。
//
// 設計方針は lib/explore.ts と同型: コンテンツ (本ファイルの配列) と UI シャーシ
// (components/NewsList 等) / i18n namespace (messages の News) を分離する。
// 各 item の title/body は ja/en を本ファイルに同梱し、i18n namespace には入れない
// (explore.ts の description と同方針)。
//
// 未読状態 (どこまで既読か) は lib/newsRead.ts + hooks/useNewsRead.ts が localStorage
// で持つ。サーバ DB / ログインは不要。
//
// 文面の誠実性: pricing 項目は lib/legal.ts の開示 (施行日 2026-06-09・2026 年 7 月利用分
// から・ガスレス受領額の 1% 基準・通常決済/受け取り自体は無料) と矛盾させない。確定でない
// ことを断定で書かない。文面は最終的に運営が直す前提の plausible な雛形だが、虚偽・誇大は禁止。

export type NewsCategory = 'feature' | 'pricing' | 'notice'; // 新機能 / 料金 / お知らせ

export type NewsItem = {
  /** 安定 ID (kebab-case)。未読判定キーに使う。重複禁止。 */
  id: string;
  /** 公開日 'YYYY-MM-DD' (表示 & ソートに使う)。 */
  date: string;
  category: NewsCategory;
  /** 見出し (locale で出し分け)。 */
  title: { ja: string; en: string };
  /** 本文 1-3 文 (プレーンテキスト・改行は \n)。 */
  body: { ja: string; en: string };
  /** 任意: 詳細への内部/外部リンク。href が '/' 始まりなら内部 (locale prefix 補完)。 */
  link?: { href: string; labelJa: string; labelEn: string };
};

// date 降順 (新しい順) で宣言する。sortedNews() が降順を保証するため宣言順自体は
// 表示順を強制しないが、可読性のため宣言時点でも新しい順に並べる。
export const NEWS_ITEMS: readonly NewsItem[] = [
  {
    id: 'jpyc-map-added',
    date: '2026-06-10',
    category: 'feature',
    title: {
      ja: '「探す」に JPYC-MAP.com を追加しました',
      en: 'Added JPYC-MAP.com to Explore',
    },
    body: {
      ja: 'JPYC が使える店舗・サービスを地図から探せる JPYC-MAP.com を「探す」のリンク集に追加しました。',
      en: 'We added JPYC-MAP.com — a map for finding stores and services that accept JPYC — to the Explore directory.',
    },
    link: { href: '/explore', labelJa: '「探す」を開く', labelEn: 'Open Explore' },
  },
  {
    id: 'usage-fee-2026-07',
    date: '2026-06-09',
    category: 'pricing',
    title: {
      ja: '2026 年 7 月のご利用分から OpenPay 利用料を申し受けます',
      en: 'OpenPay usage fee starts with July 2026 usage',
    },
    body: {
      ja: 'ガスレス決済モードをご利用の店主向けに、当月のガスレス受領額の 1% を基準とした月額の利用料を、2026 年 7 月のご利用分から翌月以降にまとめて後払いで申し受けます。\n商品代金は引き続き全額が店主へ直接・即時に着金し、当社が売上を受領・保管することはありません。決済の受け取りそのもの・通常決済（ガスあり）・顧客が gas を負担する USDC 経路は無料です。\n詳しくは利用規約をご確認ください。',
      en: 'For merchants using gasless payment mode, a monthly usage fee based on 1% of that month\'s gasless receipts will be billed in arrears, starting with July 2026 usage.\nProduct payments continue to settle in full, directly and instantly, to the merchant; OpenPay never receives or holds your sales. Receiving payments itself, standard (gas-on) payments, and the customer-pays-gas USDC route remain free.\nSee the Terms of Service for details.',
    },
    link: { href: '/terms', labelJa: '利用規約を読む', labelEn: 'Read the Terms' },
  },
  {
    id: 'jpyc-gasless-free',
    date: '2026-06-05',
    category: 'feature',
    title: {
      ja: 'JPYC のガス代を OpenPay が全額負担します（ガスレス決済）',
      en: 'OpenPay covers all JPYC gas (gasless payments)',
    },
    body: {
      ja: 'JPYC のガスレス決済では、ネットワーク手数料 (gas) を OpenPay が全額負担し、利用者から相当額を一切徴収しません。お客様は gas 用のネイティブトークンを用意せずに JPYC で支払えます。',
      en: 'For JPYC gasless payments, OpenPay covers the network fee (gas) in full and collects no equivalent from users. Customers can pay in JPYC without holding a native gas token.',
    },
  },
];

/** date 降順 (新しい順) を保証して返す。同日は宣言順を保持 (stable sort)。 */
export function sortedNews(): readonly NewsItem[] {
  return [...NEWS_ITEMS].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 最新 (sortedNews の先頭) の id。未読判定の基準。空なら null。 */
export function latestNewsId(): string | null {
  return sortedNews()[0]?.id ?? null;
}
