// /guide/ai-pay「AI が支払うガイド」の content SOT (ja/en 同梱)。
// page (app/[locale]/guide/ai-pay/page.tsx) が locale で出し分けて描画する。
//
// 設計方針 (lib/sellGuide.ts と同じ):
// - 長文コンテンツは messages/*.json でなく本モジュールに置き、ja/en を同梱する。
// - 描画は既存の PosGuidePieces / AgentGuidePieces を再利用する。
// - Claude Desktop の設定 JSON は packages/x402-mcp/README.md「Local wallet (SIGNER_MODE=keystore)」と
//   同じ env にする。版固定は /agent の生成設定と同じ AGENT_MCP_SPEC (lib/agentSetup.ts)。
// - 設定に秘密鍵を含めない (`BUYER_PRIVATE_KEY=0x...` のプレースホルダは MCP が起動時に拒否する)。
// - JPYC 入手セクションは lib/agentGuide.ts の文言を直接再利用し、ガイド間の drift を防ぐ。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
import { AGENT_MCP_SPEC } from './agentSetup';
import type { GuideStep } from './posGuide';
import {
  agentGuideContentFor,
  type AgentGuideContent,
} from './agentGuide';

export type AiPayGuideLocale = 'ja' | 'en';

type AiPayGuideLink = {
  readonly label: string;
  readonly href: string;
};

type JpycSectionContent = Pick<
  AgentGuideContent,
  | 'jpycTitle'
  | 'jpycBody'
  | 'jpycSteps'
  | 'jpycAddressLabel'
  | 'jpycAddress'
  | 'jpycAddressChainNote'
  | 'jpycLegacyWarning'
  | 'jpycGasNote'
  | 'jpycNoGasLabel'
  | 'jpycNoGasNote'
  | 'jpycLiquidityNote'
>;

const POLYGON_TX =
  '0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249';
const POLYGON_TX_URL = `https://polygonscan.com/tx/${POLYGON_TX}`;
const STEWARD_URL = 'https://github.com/Steward-Fi/steward';
const MCP_NPM_URL = 'https://www.npmjs.com/package/openpay-x402-mcp';
const SDK_NPM_URL = 'https://www.npmjs.com/package/openpay-x402-sdk';

// packages/x402-mcp/README.md「Local wallet (SIGNER_MODE=keystore)」と同じ env。
const MCP_CONFIG_JSON = [
  '{',
  '  "mcpServers": {',
  '    "openpay-x402": {',
  '      "command": "npx",',
  `      "args": ["--yes", "${AGENT_MCP_SPEC}"],`,
  '      "env": {',
  '        "SIGNER_MODE": "keystore",',
  '        "MAX_PER_CALL_JPYC": "10",',
  '        "MAX_SESSION_JPYC": "100",',
  '        "ALLOWED_HOSTS": "open-pay.jp"',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

const STRANDS_SAMPLE = [
  'from mcp import StdioServerParameters, stdio_client',
  'from strands import Agent',
  'from strands.tools.mcp import MCPClient',
  '',
  'openpay = MCPClient(lambda: stdio_client(StdioServerParameters(',
  `    command="npx", args=["-y", "${AGENT_MCP_SPEC}"],`,
  '    env={...},  # セットアップ A/B と同じ環境変数',
  ')))',
  '',
  'with openpay:',
  '    agent = Agent(tools=openpay.list_tools_sync())',
  '    agent("AI ストアで OpenPay のデモを見つけて、2 JPYC 以内で購入して")',
].join('\n');

const STRANDS_TX = '0x9bfb4cb203f5aea1a52630977c6b4b7d818a0b2d7ba40ea617de6493766be5ca';
const STRANDS_TX_URL = `https://polygonscan.com/tx/${STRANDS_TX}`;

const STEWARD_ENV = [
  'SIGNER_MODE=steward',
  'STEWARD_URL=http://localhost:3900',
  'STEWARD_TENANT=...',
  'STEWARD_API_KEY=...',
  'STEWARD_AGENT_ID=...',
  'STEWARD_AGENT_ADDRESS=0x...',
  'STEWARD_SIGNER_ID=...',
  'STEWARD_SIGNER_SECRET=...',
].join('\n');

export type AiPayGuideContent = JpycSectionContent & {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly title: string;
  readonly subtitle: string;
  /** ページ上部のリンク。トップへはヘッダのロゴで戻れるので、文脈上の親 (/agent) を指す。 */
  readonly backLink: AiPayGuideLink;

  readonly mechanismTitle: string;
  readonly mechanismIntro: string;
  readonly mechanismSteps: readonly GuideStep[];
  readonly receiptNote: string;

  readonly agentLink: AiPayGuideLink;
  /** 3 つのセットアップ (A/B/C) をまとめる節。各セットアップはたためるカードで、選び方を 1 文で先に示す。 */
  readonly setupChooseTitle: string;
  readonly setupChooseLead: string;
  /** A/B/C それぞれの「こんな人向け」(カードの見出しの下の 1 行)。 */
  readonly setupFor: readonly [string, string, string];
  readonly quickSetupTitle: string;
  /** 短い段落に分けて出す (設定 → 入金と確認)。 */
  readonly quickSetupBody: readonly string[];
  readonly quickSetupConfigLabel: string;
  readonly quickSetupConfig: string;
  readonly privateKeyWarning: string;

  readonly stewardTitle: string;
  readonly stewardBody: string;
  readonly stewardProject: AiPayGuideLink;
  readonly stewardEnvLabel: string;
  readonly stewardEnv: string;
  readonly stewardSetupLead: string;
  readonly stewardSetup: AiPayGuideLink;
  readonly stewardSetupTail: string;
  readonly stewardRecommendation: string;

  readonly thirdPartyTitle: string;
  readonly thirdPartyBody: string;
  readonly thirdPartyFacts: readonly string[];
  readonly thirdPartyLink: AiPayGuideLink;

  readonly guardsTitle: string;
  readonly guards: readonly string[];

  readonly tryTitle: string;
  readonly promptLabel: string;
  readonly prompt: string;
  readonly tryFlow: string;
  readonly proofIntro: string;
  readonly proofTransaction: AiPayGuideLink;

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaButton: string;
  readonly ctaButtonHref: string;
  readonly strandsTitle: string;
  readonly strandsBody: string;
  readonly strandsCodeLabel: string;
  readonly strandsCode: string;
  readonly strandsProofIntro: string;
  readonly strandsProofTransaction: AiPayGuideLink;

  readonly sdkLead: string;
  readonly sdkLink: AiPayGuideLink;
  readonly sdkTail: string;
  readonly sellerLead: string;
  readonly sellerLink: AiPayGuideLink;
  readonly sellerTail: string;
};

function jpycSectionFor(locale: AiPayGuideLocale): JpycSectionContent {
  const c = agentGuideContentFor(locale);
  return {
    jpycTitle: c.jpycTitle,
    jpycBody: c.jpycBody,
    jpycSteps: c.jpycSteps,
    jpycAddressLabel: c.jpycAddressLabel,
    jpycAddress: c.jpycAddress,
    jpycAddressChainNote: c.jpycAddressChainNote,
    jpycLegacyWarning: c.jpycLegacyWarning,
    jpycGasNote: c.jpycGasNote,
    jpycNoGasLabel: c.jpycNoGasLabel,
    jpycNoGasNote: c.jpycNoGasNote,
    jpycLiquidityNote: c.jpycLiquidityNote,
  };
}

const ja: AiPayGuideContent = {
  metaTitle: 'AI が支払うガイド — Claude に JPYC の支払い能力を',
  metaDescription:
    'Claude などの AI エージェントが AI ストアのデータ・API・AI への相談を JPYC で都度購入するための設定手順。専用少額ウォレット、Kova / MetaMask Agent Wallet、Steward、金銭ガード、実例を紹介します。',
  title: 'あなたの AI に、支払う力を。',
  subtitle:
    'Claude などの AI エージェントが、AI ストアのデータ・API・AI への相談を JPYC で都度購入できます。数分のセットアップで、支払いは数円から。',
  backLink: { label: '← OpenPay Agent', href: '/agent' },

  mechanismTitle: '仕組み (30 秒)',
  mechanismIntro:
    'x402 は HTTP 402 を使う支払いプロトコルです。AI は次の流れで、有料リソースを安全に購入します。',
  mechanismSteps: [
    {
      n: 1,
      title: 'カタログから発見',
      body: 'AI ストアのカタログから、必要なデータ・API・AI エージェントを見つけます。',
    },
    {
      n: 2,
      title: '見積もりを確認',
      body: 'AI が価格と利用料を取得して、合計をあなたに提示します。利用料は決済額の 1%（最低 1 JPYC）・支払う側の上乗せです。',
    },
    {
      n: 3,
      title: '承認して支払い',
      body: 'あなたが承認すると、AI がウォレットから JPYC で支払います。',
    },
    {
      n: 4,
      title: 'データを受け取る',
      body: '支払い済みのリクエストで、購入したデータや API の応答を受け取ります。',
    },
  ],
  receiptNote: 'すべての決済に、検証可能な署名レシートが付きます。',

  agentLink: { label: 'Agent ページで接続する', href: '/agent' },
  setupChooseTitle: 'セットアップを選ぶ',
  setupChooseLead:
    'まず A で試してください。本番や大きめの残高を扱うなら B、Kova や MetaMask Agent Wallet を使っているなら C です。',
  setupFor: [
    'まず試したい人向け・いちばん手軽',
    '本番の運用や、大きめの残高を扱う人向け',
    'Kova・MetaMask Agent Wallet を使っている人向け',
  ],
  quickSetupTitle: 'セットアップ A: 手軽に始める (ローカルウォレット)',
  quickSetupBody: [
    '秘密鍵を設定に貼る必要はありません。下の設定を Claude Desktop に追加して再起動し、AI に「wallet_init を呼んで」と頼むと、あなたのマシンに専用ウォレットができ、アドレスと入金用のリンクだけが返ります。',
    'そのアドレスへ使う分だけ JPYC を送れば支払えます。残高は入金用のリンク (Agent ページ)、支払い上限は wallet_status で確かめられます。',
  ],
  quickSetupConfigLabel: 'Claude Desktop の設定 JSON',
  quickSetupConfig: MCP_CONFIG_JSON,
  privateKeyWarning:
    '注意：鍵はあなたのマシンのファイル（~/.openpay-x402/wallet.json）に平文で保存されます。会話にも OpenPay にも出ませんが、あなたとしてコマンドを実行できるもの（シェルを使える AI エージェントを含む）は読めます。入れるのは失ってもよい少額だけに。OpenPay は鍵を復元できません。',

  stewardTitle: 'セットアップ B: 安全に運用する (Steward)',
  stewardBody:
    '鍵を平文のファイルにも置かない構成です。オープンソースの signing 基盤 Steward が鍵を暗号化金庫に保管し、金額上限・宛先許可・監査ログをポリシーで強制します。',
  stewardProject: {
    label: 'Steward を GitHub で見る',
    href: STEWARD_URL,
  },
  stewardEnvLabel: 'MCP に設定する署名モードと Steward の 7 変数',
  stewardEnv: STEWARD_ENV,
  stewardSetupLead: '構築手順と各変数の詳細は、',
  stewardSetup: {
    label: 'openpay-x402-mcp の Steward Setup',
    href: MCP_NPM_URL,
  },
  stewardSetupTail: 'をご覧ください。',
  stewardRecommendation:
    '本番運用や大きめの残高を扱う場合は、こちらの構成を選んでください。',

  thirdPartyTitle: 'セットアップ C: 第三者の Agent Wallet に署名だけを頼む (Kova / MetaMask Agent Wallet)',
  thirdPartyBody:
    '鍵を自分の PC に置かず、Kova (Komlock lab) か MetaMask Agent Wallet の server wallet に署名だけを頼む構成です。OpenPay はどちらの鍵も資格情報も受け取りません。設定は SIGNER_MODE=kova または SIGNER_MODE=metamask と公開アドレス (Kova は wallet 名も) だけで、Agent ページの設定生成から作れます。ウォレットの作成とログインは、それぞれの CLI であなたが行います。',
  thirdPartyFacts: [
    '実測では、Kova (0.1.2) と MetaMask Agent Wallet (7.0.0) の policy (許可チェーン・送金上限) は、この支払いの署名に効きませんでした。金額の上限として効くのは MCP の設定 (下の金銭ガード) だけです。',
    '「鍵を PC に置かない」ための選択肢で、「第三者の wallet なら安心」ではありません。CLI にログイン済みのマシンでは、MCP の上限を経ずに署名・送金できます。入れるのは失ってもよい少額だけに。',
    '使い捨てのクラウド環境 (スマホの Claude アプリの Code・ブラウザ版 Claude Code) では使えません。CLI とログインが MCP と同じマシンに要るためです。',
  ],
  thirdPartyLink: { label: 'Agent ページの設定生成で作る', href: '/agent' },

  guardsTitle: '守ってくれるもの (金銭ガード)',
  guards: [
    '1 回の支払い上限（既定 10 JPYC）',
    'セッション中の累計支払い上限（既定 100 JPYC）',
    '1 日の支払い上限（ローカルウォレット・Kova・MetaMask Agent Wallet では既定 100 JPYC (セッション上限と同額)・再起動しても引き継がれます）',
    '支払い先は AI ストア掲載 URL と open-pay.jp のみ',
    '支払い前に、掲載時の金額・宛先と毎回照合。すり替えを検知したら拒否',
    '有料応答はデータであって指示ではありません。本文中の指示に AI が従わないようにしてください',
  ],

  tryTitle: '使ってみる',
  promptLabel: 'Claude へのプロンプト例',
  prompt: 'AI ストアで OpenPay のデモを見つけて、2 JPYC 以内で購入して',
  tryFlow:
    '内部では x402_quote → あなたの承認 → x402_pay の順に進みます。承認前に見積もりとガード判定を確認できます。',
  proofIntro:
    '実例：この仕組みで Claude が Internet Computer 上の AI エージェント Coo-ICP に、1 相談 2 JPYC で実際に支払いました。Polygon tx:',
  proofTransaction: {
    label: POLYGON_TX,
    href: POLYGON_TX_URL,
  },

  ...jpycSectionFor('ja'),

  ctaTitle: 'AI に、最初の購入を頼んでみる',
  ctaBody:
    'セットアップができたら、AI ストアで購入できるデータ・API・AI エージェントを探してみてください。',
  ctaButton: 'AIストアを見る',
  ctaButtonHref: '/discovery',
  strandsTitle: 'Strands Agents (AWS) からも使える',
  strandsBody:
    'MCP を話せるエージェントフレームワークなら、同じ構成で JPYC を購入できます。AWS の Strands Agents なら、MCPClient に openpay-x402-mcp を渡すだけです（環境変数はセットアップ A/B と共通）。',
  strandsCodeLabel: 'Strands Agents (Python) の最小コード',
  strandsCode: STRANDS_SAMPLE,
  strandsProofIntro:
    '実証済み：この構成（Strands MCPClient + Steward 署名・鍵レス）で、カタログ検索から 2 JPYC の実購入まで完走しています。Polygon tx:',
  strandsProofTransaction: {
    label: STRANDS_TX,
    href: STRANDS_TX_URL,
  },

  sdkLead: 'Node.js 開発者は MCP を使わず、',
  sdkLink: {
    label: 'openpay-x402-sdk',
    href: SDK_NPM_URL,
  },
  sdkTail: 'を利用できます。',
  sellerLead: 'API や AI エージェントを売る側の手順は、',
  sellerLink: {
    label: 'API を売るガイド',
    href: '/guide/sell',
  },
  sellerTail: 'をご覧ください。',
};

const en: AiPayGuideContent = {
  metaTitle: 'Let your AI pay — give Claude JPYC purchasing power',
  metaDescription:
    'Set up Claude or another AI agent to buy data, APIs, and AI consultations from the AI Store with JPYC. Covers a dedicated low-balance wallet, Kova / MetaMask Agent Wallet, Steward, money guards, and a real example.',
  title: 'Give your AI the power to pay.',
  subtitle:
    'AI agents such as Claude can buy data, APIs and consultations with other AIs from the AI Store, paying JPYC per use. Setup takes minutes; purchases start at a few yen.',
  backLink: { label: '← OpenPay Agent', href: '/agent' },

  mechanismTitle: 'How it works (30 seconds)',
  mechanismIntro:
    'x402 is a payment protocol built on HTTP 402. Your AI buys a paid resource through the following flow.',
  mechanismSteps: [
    {
      n: 1,
      title: 'Discover it in the catalog',
      body: 'The AI finds the data, API, or AI agent it needs in the AI Store catalog.',
    },
    {
      n: 2,
      title: 'Review the quote',
      body: "The AI fetches the price and usage fee, then shows you the total. The fee is 1% of the payment (minimum 1 JPYC), added on the payer's side.",
    },
    {
      n: 3,
      title: 'Approve and pay',
      body: 'Once you approve, the AI pays JPYC from its wallet.',
    },
    {
      n: 4,
      title: 'Receive the data',
      body: 'The paid request unlocks the purchased data or API response.',
    },
  ],
  receiptNote: 'Every payment comes with a verifiable signed receipt.',

  agentLink: { label: 'Connect on the Agent page', href: '/agent' },
  setupChooseTitle: 'Choose a setup',
  setupChooseLead:
    'Start with A. Use B for production or larger balances, and C if you already use Kova or the MetaMask Agent Wallet.',
  setupFor: [
    'To try it first — the easiest path',
    'For production use or larger balances',
    'If you use Kova or the MetaMask Agent Wallet',
  ],
  quickSetupTitle: 'Setup A: the easy path (local wallet)',
  quickSetupBody: [
    'You never paste a private key into the config. Add the config below to Claude Desktop, restart it and ask your AI to “call wallet_init”: a dedicated wallet is created on your machine, and only its address and a funding link come back.',
    'Send just the JPYC you intend to use to that address and you can pay. Check the balance via the funding link (the Agent page) and the spending limits with wallet_status.',
  ],
  quickSetupConfigLabel: 'Claude Desktop config JSON',
  quickSetupConfig: MCP_CONFIG_JSON,
  privateKeyWarning:
    'Caution: the key is stored in plain text in a file on your machine (~/.openpay-x402/wallet.json). It never enters the chat or reaches OpenPay, but anything that can run commands as you — including an AI agent with shell access — can read it. Fund it only with a small amount you can afford to lose; OpenPay cannot recover the key.',

  stewardTitle: 'Setup B: safer operation (Steward)',
  stewardBody:
    'This setup keeps the key out of plain-text files too. Steward, an open-source signing platform, keeps it in an encrypted vault and enforces amount limits, destination allowlists, and audit logs through policy.',
  stewardProject: {
    label: 'View Steward on GitHub',
    href: STEWARD_URL,
  },
  stewardEnvLabel: 'Signer mode and seven Steward variables for the MCP',
  stewardEnv: STEWARD_ENV,
  stewardSetupLead: 'For setup steps and details on each variable, see ',
  stewardSetup: {
    label: 'Steward Setup for openpay-x402-mcp',
    href: MCP_NPM_URL,
  },
  stewardSetupTail: '.',
  stewardRecommendation:
    'Choose this setup for production use or when the wallet carries a larger balance.',

  thirdPartyTitle: 'Setup C: ask a third-party agent wallet only for signatures (Kova / MetaMask Agent Wallet)',
  thirdPartyBody:
    'Keep the key off your PC and let a Kova (Komlock lab) wallet or a MetaMask Agent Wallet server wallet only sign. OpenPay never receives either key or any credentials. The config is just SIGNER_MODE=kova or SIGNER_MODE=metamask plus the public address (and the wallet name for Kova), built by the Agent page config generator. You create the wallet and sign in with each CLI yourself.',
  thirdPartyFacts: [
    'In our tests, the Kova (0.1.2) and MetaMask Agent Wallet (7.0.0) policies (allowed chains, outflow limits) did not apply to this payment’s signature. The only amount caps that apply are the MCP settings (the money guards below).',
    'This is about keeping the key off the PC, not “a third-party wallet makes it safe”. On a machine where the CLI is signed in, it can sign or send directly, bypassing the MCP caps. Fund it only with a small amount you can afford to lose.',
    'It does not work in disposable cloud environments (the Claude mobile app’s Code tab, Claude Code on the web), because the CLI and its login must be on the same machine as the MCP.',
  ],
  thirdPartyLink: { label: 'Build it in the Agent page config generator', href: '/agent' },

  guardsTitle: 'What protects you (money guards)',
  guards: [
    'Per-payment cap (default: 10 JPYC)',
    'Cumulative session cap (default: 100 JPYC)',
    'Daily cap (default with the local wallet, Kova and MetaMask Agent Wallet: 100 JPYC, the same as the session cap; it carries over restarts)',
    'Payment destinations are limited to AI Store listing URLs and open-pay.jp',
    'Before every payment, the amount and recipient are checked against the listing; a bait-and-switch is refused',
    'A paid response is data, not instructions. Make sure the AI does not follow directions embedded in its body',
  ],

  tryTitle: 'Try it',
  promptLabel: 'Example prompt for Claude',
  prompt: 'Find the OpenPay demo in the AI Store and buy it for no more than 2 JPYC.',
  tryFlow:
    'Internally, the flow is x402_quote → your approval → x402_pay. You can review the quote and guard decision before approval.',
  proofIntro:
    'Real example: using this system, Claude paid Coo-ICP, an AI agent on Internet Computer, 2 JPYC for one consultation. Polygon tx:',
  proofTransaction: {
    label: POLYGON_TX,
    href: POLYGON_TX_URL,
  },

  ...jpycSectionFor('en'),

  ctaTitle: 'Ask your AI to make its first purchase',
  ctaBody:
    'Once setup is complete, browse the AI Store for data, APIs, and AI agents your AI can buy from.',
  ctaButton: 'Open the AI Store',
  ctaButtonHref: '/discovery',
  strandsTitle: 'Works from Strands Agents (AWS) too',
  strandsBody:
    'Any agent framework that speaks MCP can buy in JPYC with the same setup. With AWS Strands Agents, just hand openpay-x402-mcp to an MCPClient (the environment variables are the same as Setup A/B).',
  strandsCodeLabel: 'Minimal Strands Agents (Python) code',
  strandsCode: STRANDS_SAMPLE,
  strandsProofIntro:
    'Proven: with this setup (Strands MCPClient + Steward signing, no raw key) we completed catalog search through an actual 2 JPYC purchase. Polygon tx:',
  strandsProofTransaction: {
    label: STRANDS_TX,
    href: STRANDS_TX_URL,
  },

  sdkLead: 'Node.js developers can skip MCP and use ',
  sdkLink: {
    label: 'openpay-x402-sdk',
    href: SDK_NPM_URL,
  },
  sdkTail: ' directly.',
  sellerLead: 'To sell an API or AI agent, see ',
  sellerLink: {
    label: 'the API selling guide',
    href: '/guide/sell',
  },
  sellerTail: '.',
};

export const AI_PAY_GUIDE: Record<AiPayGuideLocale, AiPayGuideContent> = {
  ja,
  en,
};

/** locale 文字列を AiPayGuideLocale へ正規化 (未知は ja)。 */
export function aiPayGuideContentFor(locale: string): AiPayGuideContent {
  return locale === 'en' ? AI_PAY_GUIDE.en : AI_PAY_GUIDE.ja;
}

/** /guide/ai-pay の <title>/<description> を組み立てる。 */
export function guideAiPayMetadata(locale: string): Metadata {
  const c = aiPayGuideContentFor(locale);
  // OG/Twitter/canonical/hreflang は guide 共通ビルダーで (P5・N9)。
  return guidePageMetadata({
    locale,
    path: '/guide/ai-pay',
    title: `${c.metaTitle} · OpenPay`,
    description: c.metaDescription,
  });
}
