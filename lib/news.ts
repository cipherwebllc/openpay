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
// 文面の誠実性: pricing 項目は lib/legal.ts の開示 (施行日 2026-06-12・JPYC ガスレスは
// 決済1件ごとの利用料 = 当面 約2 JPYC・2026 年 7 月利用分から決済額の 1%・最低 2 JPYC・
// 負担者は店舗が選択・通常決済/受け取り自体/USDC 経路は無料) と矛盾させない。確定でない
// ことを断定で書かない。過去のお知らせは黙って書き換えず「置き換え済み」注記で更新する。

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
    id: 'per-tx-fee-2026-06-12',
    date: '2026-06-12',
    category: 'pricing',
    title: {
      ja: 'JPYC ガスレス決済の料金を改定しました（決済ごとの利用料へ）',
      en: 'JPYC gasless pricing revised: per-payment fee',
    },
    body: {
      ja: 'JPYC のガスレス決済では、決済 1 件ごとに OpenPay 利用料（当面 約 2 JPYC・2026 年 7 月のご利用分からは決済額の 1%・最低 2 JPYC）を決済時に申し受けます。手数料をお客様負担にするか店舗負担にするかは、店舗が決済設定で選択できます。\n本改定により、月次後払いの利用料（6/9 のお知らせ）および JPYC ガス全額負担（6/5 のお知らせ）の内容は置き換えられます。決済の受け取りそのもの・通常決済（ガスあり）・USDC 経路は引き続き無料です。\n詳しくは利用規約をご確認ください。',
      en: 'For JPYC gasless payments, a per-payment OpenPay fee applies at settlement (about 2 JPYC for now; from the July 2026 usage period, 1% of the payment with a 2 JPYC minimum). The merchant chooses whether the customer or the store bears it.\nThis supersedes the monthly billed-in-arrears fee (announced 6/9) and the full gas sponsorship (announced 6/5). Receiving payments itself, standard (gas-on) payments, and the USDC route remain free.\nSee the Terms of Service for details.',
    },
    link: { href: '/terms', labelJa: '利用規約を読む', labelEn: 'Read the Terms' },
  },
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
      ja: 'ガスレス決済モードをご利用の店主向けに、当月のガスレス受領額の 1% を基準とした月額の利用料を、2026 年 7 月のご利用分から翌月以降にまとめて後払いで申し受けるとお知らせしていました。\n※ 2026-06-12 の料金改定により、本お知らせの内容は「決済 1 件ごとの利用料」へ置き換えられました。最新のお知らせ・利用規約をご確認ください。',
      en: 'We previously announced a monthly usage fee based on 1% of gasless receipts, billed in arrears starting with July 2026 usage.\nNote: superseded by the 2026-06-12 pricing revision, which replaces this with a per-payment fee. See the latest announcement and the Terms of Service.',
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
      ja: 'JPYC のガスレス決済で、ネットワーク手数料 (gas) を OpenPay が全額負担する運用を開始したとお知らせしていました。お客様が gas 用のネイティブトークンを用意せずに JPYC で支払える点は変わりません。\n※ 2026-06-12 の料金改定により、ガスの負担方式は「決済 1 件ごとの利用料」へ置き換えられました。最新のお知らせ・利用規約をご確認ください。',
      en: 'We previously announced that OpenPay covers JPYC gasless network fees in full. Customers can still pay in JPYC without holding a native gas token.\nNote: superseded by the 2026-06-12 pricing revision, which replaces this with a per-payment fee. See the latest announcement and the Terms of Service.',
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
