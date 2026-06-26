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
// 文面の誠実性: pricing 項目は lib/legal.ts の開示 (施行日 2026-06-13・JPYC ガスレスは
// 決済1件ごとの利用料 = 当面 約2 JPYC・2026 年 7 月利用分から決済額の 1%・最低 2 JPYC・
// 決済は店舗負担固定でお客様は表示額のみ／チップはガス相当額をお客様(チッパー)負担で 1% 非適用・
// 通常決済/受け取り自体/USDC 経路は無料) と矛盾させない。確定でないことを断定で書かない。
// 過去のお知らせは黙って書き換えず「置き換え済み」注記で更新する。

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
    id: 'x402-facilitator-2026-06-24',
    date: '2026-06-24',
    category: 'notice',
    title: {
      ja: '【予告】AI エージェント向け JPYC 都度課金（x402 ファシリテーター）を準備中',
      en: '[Heads-up] Preparing a JPYC per-request facilitator for AI agents (x402)',
    },
    body: {
      ja: 'AI エージェントや開発者が、日本の有料 API・コンテンツに JPYC 建てで都度課金できる「x402 ファシリテーター」を準備しています（提供開始時に改めて告知します）。提供時は、決済額の 1%（最低 2 JPYC）を OpenPay 利用料として申し受けます。この利用料はお支払いになる側（買い手）の上乗せで、出品者は表示額をそのまま受け取ります（ノンカストディ・当社は売上を預かりません）。各決済には OpenPay 署名の受領証明を発行します。\n本機能は現在は既定で無効（準備中）で、決済QR・レジ・チップ・モバイル注文などの既存機能には影響しません。提供開始の時期・条件は本サービス内で改めてお知らせします。',
      en: 'We are preparing an "x402 facilitator" that lets AI agents and developers pay Japanese paid APIs and content per request in JPYC (we will announce again when it launches). At launch, OpenPay will charge a 1% facilitator fee (2 JPYC minimum), added on the buyer\'s side — the seller receives the listed amount in full, non-custodially (we do not custody sales). Each settlement is issued an OpenPay-signed receipt.\nThis feature is disabled by default for now (in preparation) and does not affect existing features (payment QR, register, tips, mobile ordering). We will announce the launch timing and terms within the service.',
    },
  },
  {
    id: 'mobile-order-fee-2026-06-18',
    date: '2026-06-18',
    category: 'pricing',
    title: {
      ja: 'モバイル注文を公開しました（システム利用料: 店頭 1%／事前 3%）',
      en: 'Mobile ordering is live (system fee: 1% in-store / 3% pre-order)',
    },
    body: {
      ja: 'スマホから注文できるモバイル注文機能を公開しました。モバイル注文の OpenPay 利用料は、店頭・券売機が決済額の 1%、事前モバイルオーダーが 3%（当社が肩代わりする gas 込み）です。決済経路を問わず、決済 1 件につきこの料率のみを申し受けます（通常の JPYC ガスレス決済の利用料と重複・加算はしません）。事前モバイルオーダーは店舗の選択で店舗負担（受取から差し引き）またはお客様上乗せ。商品代金本体は店舗のウォレットへ直接着金し（当社は売上を預かりません）、利用料分のみ同じ取引内で当社指定ウォレットへ分割します。\n決済QR（/pay）・チップ・通常の決済リンクは対象外です。\n詳しくは利用規約・特定商取引法に基づく表記をご確認ください。',
      en: 'Mobile ordering (order from your phone) is now live. The OpenPay usage fee for mobile ordering is 1% of the payment for in-store / kiosk and 3% for pre-order (gas the Company sponsors is included). Regardless of the payment path, only this rate applies per payment — it is not charged on top of the JPYC gasless per-payment fee. For pre-order, the store chooses store-borne (deducted from the receipt) or customer-added. The principal price settles directly to the store wallet (we do not custody sales); only the fee portion is split to the OpenPay wallet within the same transaction.\nPayment QR (/pay), tips, and ordinary checkout links are not subject to this fee.\nSee the Terms of Service and the Specified Commercial Transactions Act notice for details.',
    },
    link: { href: '/terms', labelJa: '利用規約を読む', labelEn: 'Read the Terms' },
  },
  {
    id: 'per-tx-fee-2026-06-12',
    date: '2026-06-12',
    category: 'pricing',
    title: {
      ja: 'JPYC ガスレス決済の料金を改定しました（決済ごとの利用料へ）',
      en: 'JPYC gasless pricing revised: per-payment fee',
    },
    body: {
      ja: 'JPYC のガスレス決済では、決済 1 件ごとに OpenPay 利用料（当面 約 2 JPYC・2026 年 7 月のご利用分からは決済額の 1%・最低 2 JPYC）を決済時に申し受けます。この利用料は店舗が負担し、お客様は表示額のみをお支払いになります。なお、クリエイターへのチップ送付では、ガス相当額（約 2 JPYC・決済額の 1% は適用しません）を、チップをお送りになるお客様にご負担いただきます。\n本改定により、月次後払いの利用料（6/9 のお知らせ）および JPYC ガス全額負担（6/5 のお知らせ）の内容は置き換えられます。決済の受け取りそのもの・通常決済（ガスあり）・USDC 経路は引き続き無料です。\n詳しくは利用規約をご確認ください。',
      en: 'For JPYC gasless payments, a per-payment OpenPay fee applies at settlement (about 2 JPYC for now; from the July 2026 usage period, 1% of the payment with a 2 JPYC minimum). The store bears this fee, and the customer pays only the displayed amount. For tips to creators, the gas-equivalent amount (about 2 JPYC; the 1% does not apply) is borne by the customer sending the tip.\nThis supersedes the monthly billed-in-arrears fee (announced 6/9) and the full gas sponsorship (announced 6/5). Receiving payments itself, standard (gas-on) payments, and the USDC route remain free.\nSee the Terms of Service for details.',
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
