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
// レジ JPYC・モバイル注文を除く通常決済/受け取り自体/USDC 経路は無料) と矛盾させない。確定でないことを断定で書かない。
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
    id: 'agent-metamask-2026-09-26',
    date: '2026-09-26',
    category: 'feature',
    title: {
      ja: 'Agent の支払いに MetaMask Agent Wallet を選べるようになりました（MCP 0.19）',
      en: 'Agents can now pay through MetaMask Agent Wallet (MCP 0.19)',
    },
    body: {
      ja: 'openpay-x402-mcp 0.19 に SIGNER_MODE=metamask を追加しました。MetaMask Agent Wallet (CLI `mm`) の server wallet に署名だけを頼み、OpenPay は MetaMask の鍵やログイン情報を受け取りません。Agent ページの設定生成で「Agent が支払う (MetaMask Agent Wallet)」を選ぶと登録用の設定が作れ、購入履歴の紐づけ (wallet_prove) も使えます。7.0.0 の実測では、この署名に 2FA は要求されず、MetaMask 側の allowed_chains と outflow 上限も適用されませんでした。金額の上限は MCP の設定だけが効きます。失ってもよい少額だけを入れてください。',
      en: 'openpay-x402-mcp 0.19 adds SIGNER_MODE=metamask. The MCP asks a MetaMask Agent Wallet server wallet (CLI `mm`) only for signatures; OpenPay never receives MetaMask keys or login credentials. Choose "Agent pays (MetaMask Agent Wallet)" in the Agent page config generator to get the registration config; purchase-history binding (wallet_prove) works too. In our test with 7.0.0, this signature required no 2FA and MetaMask\'s allowed_chains and outflow limits did not apply, so only the MCP settings cap amounts — fund the wallet with a small amount you can afford to lose.',
    },
    link: { href: '/agent', labelJa: 'Agent ページを開く', labelEn: 'Open the Agent page' },
  },
  {
    id: 'agent-kova-2026-09-25',
    date: '2026-09-25',
    category: 'feature',
    title: {
      ja: 'Agent の支払いに Kova (第三者の Agent Wallet) を選べるようになりました（MCP 0.18）',
      en: 'Agents can now pay through Kova, a third-party agent wallet (MCP 0.18)',
    },
    body: {
      ja: 'openpay-x402-mcp 0.18 に SIGNER_MODE=kova を追加しました。Komlock lab の Kova で管理するウォレットに署名だけを頼み、OpenPay は Kova の鍵や資格情報を受け取りません。Agent ページの設定生成で「Agent が支払う (Kova・第三者)」を選ぶと登録用の設定が作れ、購入履歴の紐づけ (wallet_prove) も使えます。Kova 0.1.2 の policy はこの支払い経路の金額を制限しないことを実測で確認しているため、金額の上限は MCP の設定だけが効きます。失ってもよい少額だけを入れてください。\nCircle Agent Wallet からは、USDC 建ての商品 (Base / Arc) を Circle CLI で購入できることを確認しました。JPYC 建ては JPYC の契約仕様上、Circle Agent Wallet では支払えません。',
      en: 'openpay-x402-mcp 0.18 adds SIGNER_MODE=kova. The MCP asks a wallet managed in Kova (by Komlock lab) only for signatures; OpenPay never receives Kova keys or credentials. Choose “Agent pays (Kova, third party)” in the Agent page config generator to get the registration config; purchase-history binding (wallet_prove) works too. In our test, Kova 0.1.2 policy did not limit amounts on this payment path, so only the MCP settings cap amounts — fund the wallet with a small amount you can afford to lose.\nCircle Agent Wallets can buy USDC-priced items (Base / Arc) through the Circle CLI; JPYC items cannot be paid from a Circle Agent Wallet because of the JPYC contract.',
    },
    link: { href: '/agent', labelJa: 'Agent ページを開く', labelEn: 'Open the Agent page' },
  },
  {
    id: 'agent-wallet-history-try-prompts-2026-09-22',
    date: '2026-09-22',
    category: 'feature',
    title: {
      ja: 'Agent が何を買ったかを手元で確認できます（MCP 0.16）・Agent に頼める依頼文を用意しました',
      en: 'See what your agent bought, kept on your machine (MCP 0.16) — plus ready-to-paste prompts',
    },
    body: {
      ja: 'openpay-x402-mcp 0.16 に wallet_history を追加しました。Agent が x402 で買ったもの（何を・いつ・検証済みの領収書があれば金額と取引ハッシュ）を、あなたのマシン上の記録から返します。OpenPay のサーバーが持つ x402 の決済記録とは別に、Agent の手元で読めます。記録は欠損することがあり、金額と着金の確認はオンチェーン（Agent ページのアクティビティ）が基準です。\nあわせて Agent ページに「Agent に頼めること」を追加しました。セットアップ後にそのまま貼れる依頼文 5 本（買えるものの一覧、3 JPYC のお試し購入、店の注文、購入履歴、上限の確認）を、コピーボタンつきで並べています。アクティビティは入金・送金の確定後、最長 2 分まで自動で更新されます。',
      en: 'openpay-x402-mcp 0.16 adds wallet_history: what your agent bought over x402 — which resource, when, and the amount and transaction hash when a verified receipt exists — read from a log kept on your own machine. It is readable on the agent\'s own machine, separately from the x402 payment records OpenPay keeps. The log can be incomplete; amounts and settlement are confirmed on-chain in the Agent page\'s activity.\nThe Agent page also gained “What you can ask your agent”: five ready-to-paste prompts (list what it can buy, a 3 JPYC trial purchase, order from a shop, purchase history, current limits), each with a copy button. Activity now refreshes for up to two minutes after a deposit or transfer confirms.',
    },
    link: { href: '/agent', labelJa: 'Agent ページを開く', labelEn: 'Open the Agent page' },
  },
  {
    id: 'agent-page-local-wallet-2026-09-21',
    date: '2026-09-21',
    category: 'feature',
    title: {
      ja: 'Agent ページを公開しました（秘密鍵を貼らずに AI の支払いを始められます）',
      en: 'The Agent page is live (let your AI pay without pasting a private key)',
    },
    body: {
      ja: 'Claude や Codex などの AI エージェントを OpenPay につなぐ「Agent」ページを追加しました。接続用のプロンプトをコピーするか、Claude / Codex のデスクトップアプリをそのまま開いて設定できます。支払い用のウォレットは MCP (openpay-x402-mcp 0.15) があなたのマシン上に作って保管し、鍵は会話にも OpenPay にも出ません。ただし、あなたとしてコマンドを実行できるものはこの鍵を読めるので、入れるのは少額だけにしてください。OpenPay は鍵を預からず、復元もできません。ページでは Agent のアドレスの JPYC 残高を確認でき、接続中のウォレットから入金できます（通常の送金・ガス代はあなたのウォレットから・OpenPay の徴収なし）。1 回・累計・1 日の支払い上限は Agent 側の MCP が強制する値で、OpenPay のサーバーが強制するものではありません。AI が支払うときの利用料は従来どおりです。',
      en: 'A new Agent page connects AI agents such as Claude and Codex to OpenPay. Copy a setup prompt, or open the Claude / Codex desktop app directly. The paying wallet is created and kept on your own machine by the MCP (openpay-x402-mcp 0.15); the key never enters the chat or reaches OpenPay. Anything that can run commands as you can still read it, so fund it only with a small amount. OpenPay never holds the key and cannot recover it. The page shows the agent address\'s JPYC balance and lets you fund it from your connected wallet (a plain transfer; gas is paid from your wallet and OpenPay collects nothing). Per-call, cumulative and daily spending caps are enforced by the MCP on the agent\'s side, not by OpenPay\'s servers. Usage fees for AI payments are unchanged.',
    },
    link: { href: '/agent', labelJa: 'Agent ページを開く', labelEn: 'Open the Agent page' },
  },
  {
    id: 'store-product-details-2026-09-18',
    date: '2026-09-18',
    category: 'feature',
    title: {
      ja: 'Store の商品に「詳しい説明・仕様表・実際に試す」を載せられます',
      en: 'Store products can now show a full description, a spec table and a “try it” link',
    },
    body: {
      ja: '出品フォームの「見せ方 (任意)」に 3 欄を追加しました。詳しい説明（2,000 字まで）、仕様表（8 行まで・「ラベル: 値」）、実際に試せるページへのリンク（https のみ）です。商品を開いたときに表示され、購入内容や価格・利用料には影響しません。既存の商品はそのままで、あとから追記できます。',
      en: 'The listing form\'s “Presentation (optional)” block has three new fields: a full description (up to 2,000 characters), a spec table (up to 8 rows of “label: value”) and a link to a page where buyers can try the item (https only). They appear when a product is opened and do not affect what is purchased, the price or fees. Existing products are unchanged and can be updated later.',
    },
    link: { href: '/store', labelJa: 'Store を見る', labelEn: 'Open the Store' },
  },
  {
    id: 'x402-arc-gateway-2026-09-17',
    date: '2026-09-17',
    category: 'feature',
    title: { ja: 'AI 向け有料 API が Arc の USDC でも支払えます', en: 'Paid APIs for AI agents now accept USDC on Arc' },
    body: {
      ja: 'OpenPay 自身の USDC 版有料 API (x402) に、Base に加えて Arc の支払い方法を追加しました。Arc は Circle Gateway の x402 facilitator で精算し、AI エージェントは Gateway 残高からガス不要で支払えます。価格は Base と同額で、OpenPay の手数料上乗せはありません。Base (標準 x402) は従来どおりです。Store の USDC 購入と第三者出品の USDC 面は引き続き Base のみです。',
      en: 'OpenPay\'s own USDC-priced paid APIs (x402) now offer Arc alongside Base. Arc payments settle through the Circle Gateway x402 facilitator, so agents pay gaslessly from a Gateway balance. Prices match Base and OpenPay adds no fee. Base (standard x402) is unchanged. Store USDC purchases and third-party USDC listings remain Base-only.',
    },
    link: { href: '/discovery', labelJa: 'AI ストアを見る', labelEn: 'Open the AI store' },
  },
  {
    id: 'usdc-arc-crosschain-2026-09-17',
    date: '2026-09-17',
    category: 'feature',
    title: { ja: 'Arc 宛てに他チェーンの USDC から支払えるようになりました', en: 'Pay into Arc from USDC on other chains' },
    body: {
      ja: 'Arc を受取チェーンに選んだお店へ、Base など他チェーンの USDC からも支払えます。買い手が支払元チェーンを選ぶと Circle が Arc へ転送し、転送手数料 (Circle が徴収・ガス連動で変動) は買い手が上乗せ負担、OpenPay の徴収はありません。お店には表示額がそのまま届きます。Arc から他チェーンへの支払いは非対応です。',
      en: 'Shops that receive on Arc can now be paid from USDC on other chains such as Base. The buyer picks the source chain, Circle forwards the funds to Arc, and the buyer pays Circle\'s forwarding fee (variable, gas-linked) on top; OpenPay collects nothing and the shop receives the displayed amount. Paying out of Arc to other chains is not supported.',
    },
    link: { href: '/create', labelJa: '受取 QR を作る', labelEn: 'Build a receiving QR' },
  },
  {
    id: 'usdc-arc-tip-2026-09-17',
    date: '2026-09-17',
    category: 'feature',
    title: { ja: 'Arc で USDC チップを受け取れます', en: 'Receive USDC tips on Arc' },
    body: {
      ja: 'チップリンクと @handle に USDC (Arc) を追加しました。標準モードで送り手がガスも USDC で負担し、OpenPay の徴収はありません。Arc チップはクロスチェーンとメッセージに対応しません。',
      en: 'USDC on Arc is now available for tip links and @handle. Senders pay gas in USDC in standard mode; OpenPay collects nothing. Arc tips do not support cross-chain payments or messages.',
    },
    link: { href: '/create', labelJa: 'チップリンクを作る', labelEn: 'Create a tip link' },
  },
  {
    id: 'usdc-arc-2026-09-17',
    date: '2026-09-17',
    category: 'feature',
    title: {
      ja: 'USDC の受取チェーンに Arc を追加しました（通常決済のみ・ガスも USDC）',
      en: 'Arc added as a USDC receiving chain (standard payments only, gas paid in USDC)',
    },
    body: {
      ja: 'Circle のブロックチェーン「Arc」で USDC を受け取れるようになりました。Arc ではネットワーク手数料 (ガス) も USDC で支払われるため、お客様は POL や ETH などの別トークンを用意する必要がありません。対応は通常決済のみで、ガスレス決済と別チェーンからのクロスチェーン支払いは対象外です。受取チェーンは QR 作成時に選べます。',
      en: 'You can now receive USDC on Arc, Circle\'s blockchain. On Arc, network fees (gas) are also paid in USDC, so customers do not need a separate token such as POL or ETH. Arc supports standard payments only; gasless and cross-chain payments from other chains are not available on Arc. Pick the receiving chain when you build a QR.',
    },
    link: { href: '/create', labelJa: '受取 QR を作る', labelEn: 'Build a receiving QR' },
  },
  {
    id: 'license-nft-protected-delivery-2026-09-14',
    date: '2026-09-14',
    category: 'feature',
    title: {
      ja: '利用ライセンス NFT と保護配布を追加しました（ウォレットに残る利用権・販売者サーバーからの限定配布）',
      en: 'License NFTs and protected delivery — rights that live in the buyer wallet, files served from your own server',
    },
    body: {
      ja: 'デジタル商品の新しいタイプとして「利用ライセンス NFT」を追加しました。購入すると Polygon 上の NFT (ERC-1155) が購入者のウォレットへ発行され、ソフトウェアやサービスの利用権の証明として持ち運べます。譲渡の可否は商品ごとに選べ、利用条件は OpenPay の標準ライセンス条件テンプレートを選ぶだけで設定できます。ウォレットや OpenSea では商品名と画像つきで表示されます (2026-09-14 対応)。販売数は 10,000 まで、価格は 1,000 JPYC 以上の整数で、JPYC 決済のみです。まず OpenPay 公式の商品から提供を始めています。\nあわせて「保護配布」を追加しました。ファイル本体は販売者ご自身のサーバー (Cloudflare R2 など) に置いたまま、OpenPay が購入者のウォレット署名と購入記録を確認して 60 秒だけ有効な配布チケットを発行します。当社はファイルを保管しません。連携用の SDK (openpay-x402-sdk 0.8) にテンプレートを同梱しています。\nNFT は投資対象ではなく利用権の証明です。詳しくは利用規約第 13 条をご確認ください。',
      en: 'A new digital-goods type, the "License NFT", is here. Buying one mints an ERC-1155 token on Polygon to the buyer wallet — a portable proof of the right to use your software or service. Transferability is chosen per product, and you can adopt the OpenPay standard license terms template with one click. Wallets and OpenSea now show the product name and image (as of 2026-09-14). Up to 10,000 units per product, integer prices of 1,000 JPYC or more, JPYC only. We are starting with OpenPay\'s own products.\nWe also added "protected delivery": keep files on your own server (e.g. Cloudflare R2) while OpenPay verifies the buyer\'s wallet signature and purchase record and issues a delivery ticket valid for 60 seconds. We never store your files. Templates ship in openpay-x402-sdk 0.8.\nLicense NFTs are proofs of usage rights, not investments. See Article 13 of the Terms.',
    },
    link: { href: '/guide/store', labelJa: '販売ガイドを見る', labelEn: 'Read the selling guide' },
  },
  {
    id: 'profile-branding-2026-09-12',
    date: '2026-09-12',
    category: 'feature',
    title: {
      ja: 'プロフィールと出品画面を刷新しました（カバー画像・フォント・2 列リンク・迷わない出品フォーム）',
      en: 'Profile and listing overhaul — cover image, fonts, two-column links, and a simpler listing form',
    },
    body: {
      ja: '@handle プロフィールにカバー画像 (横長の画像 URL)、フォント (標準・明朝・丸ゴシック)、リンクの並び (リスト・2 列) を追加しました。フォントは端末に依存せず表示され、SNS 共有時のカードにもカバー画像が反映されます。スマホでは編集中の見た目を画面上部のミニプレビューで確認できます。\n出品画面も整理しました。ウォレット未接続のときは接続ボタンをその場に表示し、手順を「受取先 → 恒久リンク → プロフィール」の順に。商品の種別と表示ラベルは 1 つの「配布形式」にまとめ、販売者情報は登録後に折りたたみ、任意項目は「見せ方」にまとめました。',
      en: '@handle profiles gain a cover image (wide image URL), font choice (standard, serif, rounded), and link layout (list or two columns). Fonts render the same on every device, and the cover image now appears on social share cards. On mobile, a sticky mini preview shows your changes as you edit.\nThe listing flow is simpler too: a connect button appears in place when no wallet is connected, steps run receiver → permanent link → profile, product kind and label merged into a single "delivery format", seller info collapses once saved, and optional fields live under "Presentation".',
    },
    link: { href: '/create?tab=profile', labelJa: 'プロフィールを編集する', labelEn: 'Edit your profile' },
  },
  {
    id: 'transparency-external-purchases-2026-09-11',
    date: '2026-09-11',
    category: 'notice',
    title: {
      ja: '運用透明性ページに「外部からの実購入 (オンチェーン記録)」を追加しました',
      en: 'Transparency page now lists verified third-party purchases (on-chain)',
    },
    body: {
      ja: '自社ウォレットを除いた第三者による x402 購入を、日付・チェーン・金額・買い手アドレス・トランザクションの一覧で公開しました。すべて Basescan で検証できます。週次で追記します。',
      en: 'We now publish third-party x402 purchases (our own wallets excluded) with date, chain, amount, buyer address and transaction — all verifiable on Basescan. Updated weekly.',
    },
    link: { href: '/transparency', labelJa: '運用透明性を見る', labelEn: 'View the transparency page' },
  },
  {
    id: 'ai-data-products-2026-09-01',
    date: '2026-09-01',
    category: 'feature',
    title: {
      ja: 'AI エージェント向けデータ商品を拡充しました（JPYC ライブデータ API・週次モニター・JPYC+USDC の併売）',
      en: 'More data products for AI agents — live JPYC APIs, weekly monitors, and dual JPYC/USDC listings',
    },
    body: {
      ja: 'JPYC の発行量・残高・送金履歴を返すライブデータ API、日本のステーブルコイン決済の対応状況を週次で追う「JPYC Service Monitor」「Japan Stablecoin Payment Monitor」、24 時間のネットワーク活動集計 (0.01 USDC) を AI ストアに追加しました。差分だけを安く取り直せるカーソル対応と、無料で試せるティーザーも用意しています。\n出品者向けには、1 つのリソースを JPYC と USDC (Base) の両方で販売できる「併売」を追加しました。USDC の商品は Coinbase の x402 Bazaar (agentic.market) にも掲載されます。',
      en: 'The AI store now offers live JPYC data APIs (supply, balances, transfers), two weekly change-log products — the JPYC Service Monitor and the Japan Stablecoin Payment Monitor — and a 24-hour network activity summary (0.01 USDC). Cursor-based deltas keep repeat fetches cheap, and free teasers let agents try before buying.\nSellers can now list one resource for both JPYC and USDC (Base); USDC resources are also listed on Coinbase\'s x402 Bazaar (agentic.market).',
    },
    link: { href: '/discovery', labelJa: 'AI ストアを見る', labelEn: 'Browse the AI store' },
  },
  {
    id: 'store-usdc-2026-08-17',
    date: '2026-08-17',
    category: 'pricing',
    title: {
      ja: 'デジタル商品を USDC (Base) でも購入できるようになりました（チップも USDC 対応）',
      en: 'Digital goods can now be bought with USDC on Base — tips too',
    },
    body: {
      ja: '出品者が許可した商品は、JPYC に加えて Base チェーンの USDC でも購入できます。価格は JPYC 建てのまま、当社サーバーが取得したレートで USDC 額を一定時間固定します。USDC 決済の x402 利用料は 0% (無料) で、代金は出品者のウォレットへ直接着金します。レート固定中の変動により買い手・出品者のどちらにも得または損が生じる場合があり、受取後の USDC の価格変動は出品者の負担です。\n@handle プロフィールのチップも USDC (Base) で受け取れるようになりました。詳しくは利用規約第 13 条 (9) をご確認ください。',
      en: 'Products the seller opts in can be bought with USDC on Base as well as JPYC. Prices stay in JPYC; our server converts to USDC at a fetched rate and locks it for a short window. The x402 fee for USDC payments is 0%, and funds settle directly to the seller wallet. Rate movement during the lock can favor either side, and the seller bears USDC price risk after receipt.\nTips on @handle profiles can also be received in USDC (Base). See Article 13 (9) of the Terms.',
    },
    link: { href: '/store', labelJa: 'Store を見る', labelEn: 'Browse the Store' },
  },
  {
    id: 'store-marketplace-guides-2026-08-09',
    date: '2026-08-09',
    category: 'feature',
    title: {
      ja: 'Store 一覧ページと用途別ガイドを公開しました（導入前チェックリスト・決済 QR・レジ/モバイルオーダー）',
      en: 'Store marketplace and use-case guides — pre-launch checklist, payment QR, register & mobile ordering',
    },
    body: {
      ja: 'すべてのクリエイターのデジタル商品を検索・カテゴリで探せる Store 一覧ページ (open-pay.jp/store) と、ナビゲーションの 4 区分 (決済・販売・Store・マイページ) を導入しました。商品はコピー・X・端末の共有メニューからシェアできます。\nガイドを拡充しました: 導入前チェックリスト (/guide/start)、決済 QR (/guide/qr)、レジ・モバイルオーダー (/guide/shop)、画像 URL の用意のしかた (/guide/image-url)。マイページに応援メッセージの受信箱と、商品が売れたときの通知を追加しました。デジタル商品の価格は税込総額で表示する運用に統一しています。',
      en: 'A Store marketplace (open-pay.jp/store) lets anyone search and browse every creator\'s digital goods, and the navigation is now four sections: Pay, Sell, Store, My page. Products can be shared via copy, X, or the device share sheet.\nNew guides: the pre-launch checklist (/guide/start), payment QR (/guide/qr), register & mobile ordering (/guide/shop), and how to prepare an image URL (/guide/image-url). My page gained an inbox for support messages and a notification when a product sells. Digital goods prices are shown tax-inclusive.',
    },
    link: { href: '/guide/start', labelJa: '導入前チェックリストを見る', labelEn: 'Open the pre-launch checklist' },
  },
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
      ja: 'JPYC のガスレス決済では、決済 1 件ごとに OpenPay 利用料（当面 約 2 JPYC・2026 年 7 月のご利用分からは決済額の 1%・最低 2 JPYC）を決済時に申し受けます。この利用料は店舗が負担し、お客様は表示額のみをお支払いになります。なお、クリエイターへのチップ送付では、ガス相当額（約 2 JPYC・決済額の 1% は適用しません）を、チップをお送りになるお客様にご負担いただきます。\n本改定により、月次後払いの利用料（6/9 のお知らせ）および JPYC ガス全額負担（6/5 のお知らせ）の内容は置き換えられます。決済の受け取りそのもの・通常決済（ガスあり）・USDC 経路は引き続き無料です。\n【無料範囲の補足（2026-09-24）】現在は、レジの JPYC 決済とモバイル注文は通常決済でも OpenPay 利用料の対象です。上記の通常決済の無料表記は、これらを除く通常決済に限ります。\n詳しくは利用規約をご確認ください。',
      en: 'For JPYC gasless payments, a per-payment OpenPay fee applies at settlement (about 2 JPYC for now; from the July 2026 usage period, 1% of the payment with a 2 JPYC minimum). The store bears this fee, and the customer pays only the displayed amount. For tips to creators, the gas-equivalent amount (about 2 JPYC; the 1% does not apply) is borne by the customer sending the tip.\nThis supersedes the monthly billed-in-arrears fee (announced 6/9) and the full gas sponsorship (announced 6/5). Receiving payments itself, standard (gas-on) payments, and the USDC route remain free.\n[Free-scope clarification, 2026-09-24] Register JPYC payments and mobile orders now incur an OpenPay usage fee even in standard mode. The standard-payment exemption above applies only outside those uses.\nSee the Terms of Service for details.',
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

// latestNewsId は lib/newsIndex.ts (本文を持たない索引) に移した。互換のため再 export。
export { latestNewsId } from './newsIndex';
