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
    id: 'handle-embeds-2026-08-01',
    date: '2026-08-01',
    category: 'feature',
    title: {
      ja: '@handle プロフに動画・音楽の埋め込みとリンク画像を追加しました',
      en: '@handle profiles now support media embeds and link images',
    },
    body: {
      ja: 'クリエイターページ (open-pay.jp/@あなた) のリンクに、YouTube・Spotify・Audius・ニコニコ動画・Vimeo・Apple Music・TikTok・Suno・SoundCloud の 9 サービスの埋め込み表示 (リンクごとに ON/OFF・最大 3 件) と、絵文字の代わりの画像表示を追加しました。プロフがそのままメディアハブになります。\nあわせて、デジタル商品の商品ごとのシェアリンク (X などに貼ると商品カードが表示され、開くと購入画面が自動で開きます) と、無料サービスを活用した販売手順ガイドも公開しました。',
      en: 'Links on creator pages (open-pay.jp/@you) can now render embedded players for nine services — YouTube, Spotify, Audius, Niconico, Vimeo, Apple Music, TikTok, Suno, and SoundCloud (opt-in per link, up to 3) — and show an image instead of an emoji.\nWe also added per-product share links for digital goods (pasting one on X shows a product card and opens the purchase dialog directly) and a step-by-step selling guide using free hosting services.',
    },
    link: { href: '/guide/store', labelJa: '販売ガイドを見る', labelEn: 'Read the selling guide' },
  },
  {
    id: 'creator-store-launch-2026-07-30',
    date: '2026-07-30',
    category: 'pricing',
    title: {
      ja: 'デジタル商品ストアを公開しました（@handle プロフでデジタル商品を JPYC 販売）',
      en: 'Digital goods store is live — sell digital items for JPYC on your @handle profile',
    },
    body: {
      ja: 'クリエイターが @handle プロフィールで、URL (PDF・ZIP・動画などの共有リンク) やテキスト (プロンプト・テンプレートなど) のデジタル商品を JPYC で販売できるようになりました。購入者はウォレットだけで購入でき、購入品はライブラリからいつでも再取得できます。\n売り手手数料はありません。買い手は表示価格に x402 ファシリテーター利用料 (価格の 1%・最低 1 JPYC) を上乗せしてお支払いになります。商品代金は出品者のウォレットへ直接着金し、当社は売上を預かりません (ノンカストディ)。商品本文は購入者への引き渡しのために当社が保管します。技術的なコピー防止 (DRM) はありません。オンチェーン送金は取消できませんが、商品が提供されない場合等の出品者に対する契約上の救済を妨げません。出品には販売者情報 (氏名または名称・連絡先) の登録が必要です。\n詳しくは利用規約第 13 条・特定商取引法に基づく表記をご確認ください。',
      en: 'Creators can now sell digital goods — URLs (share links to PDFs, ZIPs, videos) and text (prompts, templates) — for JPYC on their @handle profile. Buyers pay with just a wallet and can re-download purchases anytime from their library.\nThere is no seller fee; the buyer pays the listed price plus the x402 facilitator fee (1% of price, minimum 1 JPYC). Sales settle directly to the seller wallet (non-custodial); we store the product content solely to deliver it to buyers. There is no DRM. On-chain transfers are irreversible, but this does not affect contractual remedies against the seller when an item is not delivered. Sellers must register seller information (name and contact).\nSee Article 13 of the Terms and the Specified Commercial Transactions Act notice for details.',
    },
    link: { href: '/terms', labelJa: '利用規約を読む', labelEn: 'Read the Terms' },
  },
  {
    id: 'tip-question-box-2026-07-29',
    date: '2026-07-29',
    category: 'feature',
    title: {
      ja: 'チップに非公開の質問・メッセージを添えられるようになりました（質問箱）',
      en: 'Tips can now carry a private question or message',
    },
    body: {
      ja: 'チップを送るとき、非公開の質問やメッセージを添えられるようになりました。読めるのは受け取った本人だけで、ウォレットでログインした受信箱で確認できます (保存は 180 日間)。\nクリエイターの「質問箱」としてもお使いいただけます。受け取り手数料は従来どおりかかりません。',
      en: 'You can now attach a private question or message when sending a tip. Only the recipient can read it, in an inbox unlocked by wallet sign-in (messages are kept for 180 days).\nIt doubles as a creator question box. Receiving tips remains fee-free.',
    },
  },
  {
    id: 'x402-fee-floor-2026-07-05',
    date: '2026-07-05',
    category: 'pricing',
    title: {
      ja: 'x402 ファシリテーター利用料の下限を 2 JPYC から 1 JPYC に引き下げました',
      en: 'x402 facilitator fee minimum lowered from 2 JPYC to 1 JPYC',
    },
    body: {
      ja: 'x402 ファシリテーター利用料 (決済額の 1%・下限あり) の下限を、2 JPYC から 1 JPYC に引き下げました。2026-07-05 以降の決済に適用します (お客様有利の改定のため即日適用)。料率 1% と、買い手が表示価格に上乗せしてお支払いになる方式は変わりません。\n下限は、当社がオンチェーン精算のガス代を実費負担するために設けているもので、実測コストに基づいて見直しました。\n詳しくは利用規約・特定商取引法に基づく表記をご確認ください。',
      en: 'The minimum of the x402 facilitator fee (1% of the payment, with a floor) has been lowered from 2 JPYC to 1 JPYC, effective for payments on and after 2026-07-05 (applied immediately as the revision favors payers). The 1% rate and the buyer-side surcharge model are unchanged.\nThe floor exists because we bear the actual on-chain settlement gas; it has been revised based on measured cost.\nSee the Terms of Service and the Specified Commercial Transactions Act notice for details.',
    },
    link: { href: '/terms', labelJa: '利用規約を読む', labelEn: 'Read the Terms' },
  },
  {
    id: 'x402-facilitator-launch-2026-06-28',
    date: '2026-06-28',
    category: 'pricing',
    title: {
      ja: 'x402 ファシリテーター（AI エージェント向け JPYC 都度課金）を公開しました',
      en: 'x402 facilitator (JPYC per-request billing for AI agents) is live',
    },
    body: {
      ja: 'AI エージェントや開発者が、有料 API・コンテンツに JPYC 建てで都度課金できる x402 ファシリテーターを公開しました。登録したリソースは公開カタログ（/discovery・/api/discovery）から発見でき、エージェントはそのまま JPYC で支払えます。\nx402 ファシリテーター利用料は決済額の 1%・最低 2 JPYC で、お支払いになる側（買い手）が表示価格に上乗せします（出品者は表示額をそのまま受け取ります）。商品代金本体は出品者のウォレットへ直接着金し、当社は売上を預かりません（ノンカストディ）。当社が肩代わりするガス代も本利用料に含まれ、各決済には OpenPay 署名の受領証明を発行します。本利用料は既存の OpenPay 利用料・モバイル注文システム利用料とは別個で、x402 経由の決済にのみ適用します。\n※ 2026-07-05 の改定により、下限は 2 JPYC から 1 JPYC に引き下げられました。最新のお知らせ・利用規約をご確認ください。\n詳しくは利用規約・特定商取引法に基づく表記をご確認ください。',
      en: 'The x402 facilitator — letting AI agents and developers pay paid APIs and content per request in JPYC — is now live. Registered resources are discoverable from the public catalog (/discovery, /api/discovery), and agents can pay directly in JPYC.\nThe x402 facilitator fee is 1% of the payment (2 JPYC minimum), added on the buyer side (the seller receives the listed amount in full). The principal settles directly to the seller wallet; we do not custody sales (non-custodial). Gas we sponsor is included in this fee, and each settlement is issued an OpenPay-signed receipt. This fee is separate from the existing OpenPay usage fee and the mobile-ordering system fee, and applies only to x402 payments.\nNote: the minimum was lowered from 2 JPYC to 1 JPYC in the 2026-07-05 revision — see the latest news and Terms.\nSee the Terms of Service and the Specified Commercial Transactions Act notice for details.',
    },
    link: { href: '/terms', labelJa: '利用規約を読む', labelEn: 'Read the Terms' },
  },
  {
    id: 'x402-facilitator-2026-06-24',
    date: '2026-06-24',
    category: 'notice',
    title: {
      ja: '【予告】AI エージェント向け JPYC 都度課金（x402 ファシリテーター）を準備中',
      en: '[Heads-up] Preparing a JPYC per-request facilitator for AI agents (x402)',
    },
    body: {
      ja: 'AI エージェントや開発者が、日本の有料 API・コンテンツに JPYC 建てで都度課金できる「x402 ファシリテーター」を準備しています（提供開始時に改めて告知します）。提供時は、決済額の 1%（最低 2 JPYC）を OpenPay 利用料として申し受けます。この利用料はお支払いになる側（買い手）の上乗せで、出品者は表示額をそのまま受け取ります（ノンカストディ・当社は売上を預かりません）。各決済には OpenPay 署名の受領証明を発行します。\n本機能は現在は既定で無効（準備中）で、決済QR・レジ・チップ・モバイル注文などの既存機能には影響しません。提供開始の時期・条件は本サービス内で改めてお知らせします。\n※ 2026-06-28 に提供を開始しました（最新のお知らせ・利用規約をご覧ください）。',
      en: 'We are preparing an "x402 facilitator" that lets AI agents and developers pay Japanese paid APIs and content per request in JPYC (we will announce again when it launches). At launch, OpenPay will charge a 1% facilitator fee (2 JPYC minimum), added on the buyer\'s side — the seller receives the listed amount in full, non-custodially (we do not custody sales). Each settlement is issued an OpenPay-signed receipt.\nThis feature is disabled by default for now (in preparation) and does not affect existing features (payment QR, register, tips, mobile ordering). We will announce the launch timing and terms within the service.\nNote: launched on 2026-06-28 — see the latest announcement and the Terms of Service.',
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
