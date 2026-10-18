// /guide/agent「AI で注文するガイド」の content SOT (ja/en 同梱)。
// page (app/[locale]/guide/agent/page.tsx) が locale で出し分けて描画する。
//
// 背景: 訪日客が自分の AI (Claude 等) に母国語で相談して日本の店へモバイル注文し、
// 支払いは決済リンクを開いて自分のウォレットで JPYC を 1 タップ (plans/inbound-agent-order.md
// Phase B)。AI は財布を持たない — 支払いは常に人間の最終承認。
//
// 設計方針 (lib/posGuide.ts と同じ):
// - 長文コンテンツは messages/*.json でなく本モジュールに置く (新規 i18n namespace を増やさず
//   parity test の対象を汚さない)。ja/en は本モジュールに同梱。
// - 図版は使わない: この面の要となる視覚要素は「MCP の設定 JSON」と「JPYC コントラクトアドレス」で、
//   これらは装飾 SVG でなくコードブロック / モノスペース表示が正しい (対象読者=開発者寄りの early
//   adopter)。図版 SVG を足すと public/guide の孤児検査 (tests/lib/posGuide.test.ts) と衝突するため
//   にも避ける。描画は Section/BulletList/StepList (PosGuidePieces) の再利用 + CodeBlock/AddressCallout
//   (AgentGuidePieces) の最小追加で賄う。
// - 手数料率など変動値は本文に断定で書かない: 正確な値は利用規約・特商法表記へ誘導する (posGuide と同方針)。
// - JPYC コントラクトアドレスは lib/tokens.ts の権威値から取得する (本ファイルに転記しない — 誤アドレスは
//   資金喪失に直結)。全 chain で同一 (JPYC v3 cross-chain consistency)。
// - 「交換業回避」の法的第一条 (plans §1): OpenPay は通貨変換を実行しない。ガイドは自助 swap の案内のみ。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
import type { GuideStep, GuideFaq } from './posGuide';
import { defaultDeploymentForSymbol } from './tokens';

export type AgentGuideLocale = 'ja' | 'en';

// JPYC v3 コントラクトアドレス。lib/tokens.ts の権威値 (Polygon default deployment) から取得する。
// JPYC v3 は Polygon / Kaia / Avalanche / Ethereum で同一 address。ガイドに文字列転記せず、tokens.ts を
// 単一情報源にすることで、万一 tokens.ts 側が更新されても表示が自動追従し drift を防ぐ (test でも同値照合)。
export const JPYC_CONTRACT_ADDRESS = defaultDeploymentForSymbol('jpyc').address;

// MCP 設定スニペット (ja/en 共通・言語非依存)。**鍵不要** の order profile 向け:
// find_shops / order_menu / order_summary / createOrderLink の 4 ツールだけを公開し、BUYER_PRIVATE_KEY は不要。
// x402_pay / order_quote は profile 自体に存在しないため、「AI に財布を持たせない」原則を設定面で固定する。
// command/args は packages/x402-mcp の副 bin (`openpay-order-mcp`) と README の npx 呼び出しに一致。
const MCP_CONFIG_JSON = [
  '{',
  '  "mcpServers": {',
  '    "openpay-order": {',
  '      "command": "npx",',
  '      "args": ["--yes", "--package=openpay-x402-mcp", "--", "openpay-order-mcp"]',
  '    }',
  '  }',
  '}',
].join('\n');

// ヒーロー画像 (実 UI 3 画面合成: AI 会話→事前充填→決済手前)。src/寸法は言語非依存で共有し、
// alt のみ locale 別。public/guide-agent/ に配置 (public/guide/ は posGuide の孤児検査対象ゆえ分離)。
const HERO_SRC = '/guide-agent/hero.webp';
const HERO_WIDTH = 1600;
const HERO_HEIGHT = 840;

export type AgentGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly title: string;
  readonly lead: string;
  readonly heroImage: {
    readonly src: string;
    readonly alt: string;
    readonly width: number;
    readonly height: number;
  };

  readonly canDoTitle: string;
  readonly canDo: readonly string[];
  readonly cannotTitle: string;
  readonly cannot: readonly string[];

  readonly needTitle: string;
  readonly need: readonly string[];


  readonly setupTitle: string;
  readonly setupIntro: string;
  readonly setupSteps: readonly GuideStep[];
  /** クラウド環境で使うときの注意 (たためるカードの見出しと短い箇条)。 */
  readonly setupEnvironmentNote: { readonly title: string; readonly items: readonly string[] };
  readonly configLabel: string;
  readonly configCode: string;
  readonly configNote: string;

  readonly flowTitle: string;
  readonly flowSteps: readonly GuideStep[];

  readonly jpycTitle: string;
  readonly jpycBody: string;
  readonly jpycSteps: readonly GuideStep[];
  readonly jpycAddressLabel: string;
  readonly jpycAddress: string;
  readonly jpycAddressChainNote: string;
  readonly jpycLegacyWarning: string;
  readonly jpycGasNote: string;
  /** jpycNoGasNote (MetaMask のガス込みスワップ) をたたむ「くわしく」の名前。 */
  readonly jpycNoGasLabel: string;
  readonly jpycNoGasNote: string;
  readonly jpycLiquidityNote: string;

  readonly disclosuresTitle: string;
  readonly disclosures: readonly string[];

  readonly safetyTitle: string;
  readonly safetyBody: string;
  readonly safety: readonly string[];
  readonly safetyNote: string;

  readonly faqTitle: string;
  readonly faqs: readonly GuideFaq[];

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaButton: string;
  readonly ctaButtonHref: string;

  /** ページ上部のリンク。トップへはヘッダのロゴで戻れるので、文脈上の親 (/agent) を指す。 */
  readonly consoleLink: { readonly label: string; readonly href: string };
};

const ja: AgentGuideContent = {
  metaTitle: 'OpenPay モバイルオーダーを AI に頼んで注文する（訪日客向けガイド）',
  metaDescription:
    '日本語がわからなくても、OpenPay モバイルオーダー対応のお店なら、自分の AI（Claude など）に頼んで注文できます。支払いは決済リンクを開いて自分のウォレットで JPYC を 1 タップ。OpenPay は通貨の交換・両替を行いません。',
  title: '日本語がわからなくても、OpenPay モバイルオーダーなら AI で注文できる',
  lead: 'あなたの AI（Claude など）に母国語で相談するだけ。AI がメニューを読んで注文を組み、決済リンクを作ります。あなたはリンクを開いて確認し、自分のウォレットで JPYC を払うだけです。',
  heroImage: {
    src: HERO_SRC,
    alt: 'AI との会話（母国語）→ 注文が事前充填された決済画面 → 自分のウォレットで支払い、の 3 画面',
    width: HERO_WIDTH,
    height: HERO_HEIGHT,
  },

  canDoTitle: 'できること',
  canDo: [
    'AI がメニューを母国語で説明し、注文を組んで決済リンク（createOrderLink）を作る',
    'あなたが決済画面で店舗名・明細・合計を確かめ、自分のウォレットで支払う',
    'JPYC（円ステーブルコイン）はあなたからお店へ直接・すぐに届く（ノンカストディ）',
  ],
  cannotTitle: 'できないこと（＝あえてしないこと）',
  cannot: [
    'AI は支払いません。財布（秘密鍵）を持たず、支払いは必ずあなたが承認します',
    'OpenPay は暗号資産の交換・両替を行いません。JPYC の入手（スワップ）は、ご自身で外部サービスを使います',
  ],

  needTitle: '必要なもの',
  need: [
    'MCP に対応した AI クライアント（Claude Desktop / Claude Code など）',
    '暗号資産ウォレット（MetaMask などの、あなたのウォレット）',
    'Polygon 上の JPYC（少量の POL＝ガス代も）。入手方法は下記「JPYC の入手」へ',
  ],

  setupTitle: 'セットアップ（AI に MCP を追加）',
  setupIntro:
    'openpay-order-mcp（openpay-x402-mcp の order profile）は、お店探し（find_shops）・メニュー取得・支払額の確認・決済リンク作成だけを AI に使わせる MCP サーバーです。自動で支払うツールはなく、鍵も設定に入れません。',
  setupSteps: [
    {
      n: 1,
      title: 'AI クライアントの MCP 設定を開く',
      body: 'AI クライアント（Claude Desktop・Claude Code など）の MCP 設定（mcpServers）を開きます。MCP に対応する他のクライアントでも、同じ npx コマンドで追加できます。',
    },
    {
      n: 2,
      title: '下記の設定を追加して再起動',
      body: '下のブロックを mcpServers に追加して保存し、クライアントを再起動します（Node.js 20 以上が必要）。',
    },
    {
      n: 3,
      title: 'AI に頼んでみる',
      body: '店名を伝えてお店を探すよう頼むと、AI が find_shops でお店を見つけ、order_menu でメニューを読み込みます。',
    },
  ],
  setupEnvironmentNote: {
    title: 'クラウド環境（スマホの Claude アプリ・ブラウザ版 Claude Code）で使うとき',
    items: [
      'PC のローカルで動く Claude Code / Codex なら、Local Wallet・Kova・MetaMask Agent Wallet・Steward が使えます。',
      'スマホの Claude アプリの Code やブラウザ版 Claude Code は使い捨てのクラウド環境です。Local Wallet は鍵ごと消えるので、JPYC を入れないでください。',
      'Kova と MetaMask Agent Wallet は、CLI とログイン状態が同じマシンに要るため使えません。',
      '「人が支払う」（openpay-order-mcp）は鍵不要でどこでも使えます（登録はセッションごとに消えることがあります）。クラウドから Agent に支払わせるなら、自分のサーバで署名する Steward を使ってください。',
    ],
  },
  configLabel: '設定例（支払い用の鍵は不要）',
  configCode: MCP_CONFIG_JSON,
  configNote:
    'この設定に秘密鍵は入れません（AI は支払わないため）。詳細は npm の openpay-x402-mcp をご覧ください。',

  flowTitle: '注文の流れ',
  flowSteps: [
    {
      n: 1,
      title: 'AI に相談して注文を決める',
      body: '「近くの @（店舗）で、辛さ控えめのラーメンを 1 つ」のように母国語で相談します。AI がメニューと価格を確かめて注文を組みます。',
    },
    {
      n: 2,
      title: 'AI に決済リンクを作ってもらう',
      body: 'AI が createOrderLink で open-pay.jp/@（店舗）?cart=… の決済リンクを返します。まだ支払いは起きません（受取先と価格は、お店のハンドルからサーバーがその都度決めます）。',
    },
    {
      n: 3,
      title: 'リンクを開いて内容を確認',
      body: 'スマホでリンクを開くと、店舗名・明細・合計（JPYC）が出ます。店舗名と金額を必ず確かめてください。',
    },
    {
      n: 4,
      title: '自分のウォレットで 1 タップ支払い',
      body: '正しければ、あなたのウォレットで署名して支払います。JPYC はお店のウォレットへ直接届きます。',
    },
  ],

  jpycTitle: 'JPYC の入手（Polygon）',
  jpycBody:
    '支払いには Polygon 上の JPYC を使います。手持ちの USDC などは、外部の DEX（分散型取引所・例：Uniswap の Polygon の USDC/JPYC プール）でご自身でスワップできます。OpenPay は交換・両替を行いません。',
  jpycSteps: [
    {
      n: 1,
      title: 'Polygon に切り替え、少量の POL を用意',
      body: 'ウォレットのネットワークを Polygon にし、ガス代用に少量の POL を用意します。',
    },
    {
      n: 2,
      title: 'DEX で USDC などから JPYC にスワップ',
      body: 'Polygon 対応の DEX で、手持ちのトークンから JPYC にスワップします。必要な分だけで十分です。',
    },
    {
      n: 3,
      title: 'スワップ前にコントラクトアドレスを必ず確認',
      body: '受け取る JPYC のアドレスが、下の正しい v3 アドレスと一致するか必ず確かめてください。似た名前の別トークンに注意。',
    },
  ],
  jpycAddressLabel: 'JPYC（v3）コントラクトアドレス',
  jpycAddress: JPYC_CONTRACT_ADDRESS,
  jpycAddressChainNote:
    'このアドレスは Polygon / Kaia / Avalanche / Ethereum で共通です（JPYC v3）。',
  jpycLegacyWarning:
    '注意：旧プリペイド型の JPYC v1（0x431d… で始まる別トークン）と間違えないでください。スワップ先は必ず上記 v3 アドレスに。',
  jpycGasNote: 'スワップの実行には、少量の POL（ガス代）が必要です。',
  jpycNoGasLabel: 'ガス代（POL）が無いとき',
  jpycNoGasNote:
    'MetaMask の「Gas Station（ガス込みスワップ）」を使うと、Polygon では POL を持っていなくても、手持ちの USDC などからガス代を払って USDC→JPYC のスワップができます（Base / Arbitrum も対応・スマートアカウントへの自動アップグレードが必要／Optimism 等は非対応で少量の ETH が別途必要）。※この機能は MetaMask が提供するもので、OpenPay は関与しません。対応チェーン・トークンや混雑状況により成立しない場合があります。',
  jpycLiquidityNote:
    'DEX の流動性・レート・プールは変動します。スワップ実行時に最新の状況をご確認ください。',

  disclosuresTitle: '重要なお知らせ',
  disclosures: [
    'OpenPay は暗号資産の交換・両替を行いません。スワップはお客様ご自身が外部サービス（DEX 等）で行うものです。',
    '本ガイドは情報提供であり、投資助言ではありません。',
    'トークンのコントラクトアドレスは、必ず JPYC の公式情報（JPYC EX・jpyc.co.jp）でご確認ください。',
  ],

  safetyTitle: '安全に使うために',
  safetyBody:
    '支払いはすべて、あなたのウォレットから、あなたの操作で行われます。',
  safety: [
    'ノンカストディ — OpenPay も AI も、あなたの資金を預かりません。',
    '署名は 1 回だけ — AI に秘密鍵やウォレットを渡す必要はありません。',
    '払う前に確認 — 決済画面で店舗名と金額（JPYC）を確かめてから署名します。',
  ],
  safetyNote:
    'ブロックチェーンの支払いは、完了後の取り消しができません。店舗名と金額を確認してから支払ってください。',

  faqTitle: 'よくある質問',
  faqs: [
    {
      q: 'AI が勝手に支払ってしまいませんか？',
      a: 'いいえ。AI は決済リンクを作るだけで、支払いは必ずあなたがウォレットで承認します。秘密鍵を渡す必要もありません。',
    },
    {
      q: '日本語がわからなくても使えますか？',
      a: 'はい。AI には母国語で相談できます。決済画面は日本語と英語に対応し、ブラウザの翻訳も使えます。',
    },
    {
      q: 'JPYC を持っていません。',
      a: '「JPYC の入手」のとおり、Polygon の DEX で手持ちのトークンからスワップできます。OpenPay は交換を行わないため、スワップはご自身で行ってください。',
    },
    {
      q: '支払う金額はどこで分かりますか？',
      a: '決済画面の合計（JPYC）が支払う金額です。店舗側の利用料などは、利用規約と特定商取引法に基づく表記をご確認ください。',
    },
  ],

  ctaTitle: 'AIストアを見てみる',
  ctaBody:
    'openpay-order-mcp を AI に追加すれば、鍵を渡さずに、母国語で日本のお店に注文できます。支払いに対応したリソースは「AIストア」で見られます。',
  ctaButton: 'AIストアを見る',
  ctaButtonHref: '/discovery',

  consoleLink: { label: 'OpenPay Agent を開く', href: '/agent' },
};

const en: AgentGuideContent = {
  metaTitle: 'Order at OpenPay mobile-order shops with your AI (visitor guide)',
  metaDescription:
    "Even if you don't read Japanese, at shops that use OpenPay mobile order you can ask your AI (such as Claude) to place the order. You pay by opening the checkout link and tapping once in your own wallet with JPYC. OpenPay does not exchange or convert currencies.",
  title: "Can't read Japanese? Order at OpenPay shops with your AI",
  lead: 'Just talk to your AI (such as Claude) in your own language. It reads the menu, builds the order and creates a checkout link; you open the link, review it and pay JPYC from your own wallet.',
  heroImage: {
    src: HERO_SRC,
    alt: 'Three screens: chatting with an AI in your language → the order pre-filled on the checkout screen → paying from your own wallet',
    width: HERO_WIDTH,
    height: HERO_HEIGHT,
  },

  canDoTitle: 'What you can do',
  canDo: [
    'Your AI explains the menu in your language, builds the order and creates a checkout link (createOrderLink)',
    'You check the shop name, line items and total on the checkout screen, then pay from your own wallet',
    'JPYC (a JPY stablecoin) goes straight from you to the shop, instantly (non-custodial)',
  ],
  cannotTitle: "What it does not do (by design)",
  cannot: [
    "The AI does not pay for you. It holds no wallet (no private key), and you always approve the payment",
    'OpenPay does not exchange or convert crypto. You obtain JPYC (by swapping) yourself using an external service',
  ],

  needTitle: 'What you need',
  need: [
    'An MCP-capable AI client (Claude Desktop / Claude Code, etc.)',
    'A crypto wallet (your own wallet, e.g. MetaMask)',
    'JPYC on Polygon (plus a little POL for gas). See “Getting JPYC” below',
  ],

  setupTitle: 'Setup (add the MCP to your AI)',
  setupIntro:
    'openpay-order-mcp (the order profile in openpay-x402-mcp) lets your AI only find a shop (find_shops), read its menu, check the amount and create a checkout link. It has no tools that pay, and no key goes into the config.',
  setupSteps: [
    {
      n: 1,
      title: 'Open your AI client’s MCP settings',
      body: 'Open the MCP settings (mcpServers) of your AI client (Claude Desktop, Claude Code, etc.). Other MCP-capable clients can add it with the same npx command.',
    },
    {
      n: 2,
      title: 'Add the config below and restart',
      body: 'Add the block below to mcpServers, save and restart the client (Node.js 20+ required).',
    },
    {
      n: 3,
      title: 'Ask your AI',
      body: 'Ask the AI to find a shop by name. It uses find_shops to find it, then order_menu to read the menu.',
    },
  ],
  setupEnvironmentNote: {
    title: 'Using it in a cloud environment (the Claude mobile app or Claude Code on the web)',
    items: [
      'Claude Code or Codex on your PC can use Local Wallet, Kova, MetaMask Agent Wallet, or Steward.',
      "The Claude mobile app's Code tab and Claude Code on the web are disposable cloud environments. A Local Wallet disappears with its key, so do not fund it.",
      'Kova and MetaMask Agent Wallet cannot run there: they need their CLI and login on the same machine.',
      'Human pays (openpay-order-mcp) needs no key and works anywhere (registration may disappear between sessions). For agent payments from the cloud, use Steward, which signs on your own server.',
    ],
  },
  configLabel: 'Example config (no payment key needed)',
  configCode: MCP_CONFIG_JSON,
  configNote:
    'No private key goes in this config (the AI does not pay). See openpay-x402-mcp on npm for details.',

  flowTitle: 'The ordering flow',
  flowSteps: [
    {
      n: 1,
      title: 'Decide the order with your AI',
      body: 'Say, in your language, “one ramen, mild spice, at @(shop) nearby”. The AI checks the menu and prices and builds the order.',
    },
    {
      n: 2,
      title: 'Have your AI create a checkout link',
      body: 'The AI returns a checkout link like open-pay.jp/@(shop)?cart=… via createOrderLink. No payment happens yet (the recipient and prices are resolved server-side from the shop’s handle each time).',
    },
    {
      n: 3,
      title: 'Open the link and review',
      body: 'Open the link on your phone to see the shop name, line items and total (JPYC). Always check the shop name and amount.',
    },
    {
      n: 4,
      title: 'Pay with one tap from your wallet',
      body: 'If it looks right, sign and pay from your own wallet. JPYC goes directly to the shop’s wallet.',
    },
  ],

  jpycTitle: 'Getting JPYC (on Polygon)',
  jpycBody:
    'Payment uses JPYC on Polygon. You can swap USDC or similar for JPYC yourself on an external DEX (e.g. Uniswap’s USDC/JPYC pool on Polygon). OpenPay does not exchange or convert currencies.',
  jpycSteps: [
    {
      n: 1,
      title: 'Switch to Polygon and get a little POL',
      body: 'Set your wallet network to Polygon and keep a little POL for gas.',
    },
    {
      n: 2,
      title: 'Swap from USDC (etc.) to JPYC on a DEX',
      body: 'On a Polygon DEX, swap your token for JPYC — only as much as you need.',
    },
    {
      n: 3,
      title: 'Verify the contract address before swapping',
      body: 'Make sure the JPYC you receive matches the correct v3 address below. Beware of similarly named tokens.',
    },
  ],
  jpycAddressLabel: 'JPYC (v3) contract address',
  jpycAddress: JPYC_CONTRACT_ADDRESS,
  jpycAddressChainNote:
    'This address is the same on Polygon / Kaia / Avalanche / Ethereum (JPYC v3).',
  jpycLegacyWarning:
    'Note: do not confuse it with the legacy prepaid JPYC v1 (a different token starting 0x431d…). Always swap into the v3 address above.',
  jpycGasNote: 'Running the swap needs a little POL (gas).',
  jpycNoGasLabel: 'If you have no gas (POL)',
  jpycNoGasNote:
    "With MetaMask's “Gas Station” (gas-included swaps), on Polygon you can swap USDC→JPYC paying the fee from your USDC even without holding POL (Base / Arbitrum are supported too, and your account is auto-upgraded to a smart account; Optimism and others are not supported and need a little ETH separately). Note: this is a MetaMask feature — OpenPay is not involved — and a swap may not go through depending on the chain, tokens, or network congestion.",
  jpycLiquidityNote:
    'DEX liquidity, rates, and pools change over time. Please check the latest conditions when you swap.',

  disclosuresTitle: 'Important notes',
  disclosures: [
    'OpenPay does not exchange or convert crypto. Any swap is performed by you on an external service (such as a DEX).',
    'This guide is for information only and is not investment advice.',
    'Always verify a token’s contract address using JPYC’s official information (JPYC EX / jpyc.co.jp).',
  ],

  safetyTitle: 'Staying safe',
  safetyBody: 'Every payment happens from your own wallet, with your own action.',
  safety: [
    'Non-custodial — neither OpenPay nor the AI holds your funds.',
    'One signature only — you never hand a private key or wallet to the AI.',
    'Check before paying — confirm the shop name and amount (JPYC) on the checkout screen before signing.',
  ],
  safetyNote:
    'Blockchain payments cannot be reversed once complete. Confirm the shop name and amount before you pay.',

  faqTitle: 'FAQ',
  faqs: [
    {
      q: 'Could the AI pay on its own?',
      a: 'No. The AI only creates a checkout link; you always approve the payment in your wallet, and you never give it a private key.',
    },
    {
      q: "Can I use it if I don't read Japanese?",
      a: 'Yes. You can talk to the AI in your own language. The checkout screen supports Japanese and English, and your browser can translate it too.',
    },
    {
      q: "I don't have JPYC.",
      a: 'As in “Getting JPYC”, you can swap from a token you hold on a Polygon DEX. OpenPay does not exchange, so you perform the swap yourself.',
    },
    {
      q: 'Where do I see the amount to pay?',
      a: 'The total (JPYC) on the checkout screen is what you pay. For the shop-side usage fee and other details, see the Terms and legal notice.',
    },
  ],

  ctaTitle: 'Explore the AI store',
  ctaBody:
    'Add openpay-order-mcp to your AI and order at Japanese shops in your own language, without handing it a key. Payable resources are listed in the “AI store”.',
  ctaButton: 'Open the AI store',
  ctaButtonHref: '/discovery',

  consoleLink: { label: 'Open OpenPay Agent', href: '/agent' },
};

export const AGENT_GUIDE: Record<AgentGuideLocale, AgentGuideContent> = { ja, en };

/** locale 文字列を AgentGuideLocale へ正規化 (未知は ja)。 */
export function agentGuideContentFor(locale: string): AgentGuideContent {
  return locale === 'en' ? AGENT_GUIDE.en : AGENT_GUIDE.ja;
}

/** /guide/agent の <title>/<description> を組み立てる (page の generateMetadata が利用)。 */
export function guideAgentMetadata(locale: string): Metadata {
  const c = agentGuideContentFor(locale);
  // OG/Twitter/canonical/hreflang は guide 共通ビルダーで (P5・N9)。
  return guidePageMetadata({
    locale,
    path: '/guide/agent',
    title: `${c.metaTitle} · OpenPay`,
    description: c.metaDescription,
  });
}
