// /guide/ai-pay「AI が支払うガイド」の content SOT (ja/en 同梱)。
// page (app/[locale]/guide/ai-pay/page.tsx) が locale で出し分けて描画する。
//
// 設計方針 (lib/sellGuide.ts と同じ):
// - 長文コンテンツは messages/*.json でなく本モジュールに置き、ja/en を同梱する。
// - 描画は既存の PosGuidePieces / AgentGuidePieces を再利用する。
// - Claude Desktop の設定 JSON は packages/x402-mcp/README.md の x402 profile と同一にする。
// - JPYC 入手セクションは lib/agentGuide.ts の文言を直接再利用し、ガイド間の drift を防ぐ。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
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
  | 'jpycNoGasNote'
  | 'jpycLiquidityNote'
>;

const POLYGON_TX =
  '0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249';
const POLYGON_TX_URL = `https://polygonscan.com/tx/${POLYGON_TX}`;
const STEWARD_URL = 'https://github.com/Steward-Fi/steward';
const MCP_NPM_URL = 'https://www.npmjs.com/package/openpay-x402-mcp';
const SDK_NPM_URL = 'https://www.npmjs.com/package/openpay-x402-sdk';

// packages/x402-mcp/README.md「x402 profile > Claude Desktop」と同一。
const MCP_CONFIG_JSON = [
  '{',
  '  "mcpServers": {',
  '    "openpay-x402": {',
  '      "command": "npx",',
  '      "args": ["openpay-x402-mcp"],',
  '      "env": {',
  '        "SIGNER_MODE": "env-key",',
  '        "BUYER_PRIVATE_KEY": "0x...",',
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
  '    command="npx", args=["-y", "openpay-x402-mcp"],',
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
  readonly backHome: string;

  readonly mechanismTitle: string;
  readonly mechanismIntro: string;
  readonly mechanismSteps: readonly GuideStep[];
  readonly receiptNote: string;

  readonly quickSetupTitle: string;
  readonly quickSetupBody: string;
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
    jpycNoGasNote: c.jpycNoGasNote,
    jpycLiquidityNote: c.jpycLiquidityNote,
  };
}

const ja: AiPayGuideContent = {
  metaTitle: 'AI が支払うガイド — Claude に JPYC の支払い能力を',
  metaDescription:
    'Claude などの AI エージェントが AI ストアのデータ・API・AI への相談を JPYC で都度購入するための設定手順。専用少額ウォレット、Steward、金銭ガード、実例を紹介します。',
  title: 'あなたの AI に、支払う力を。',
  subtitle:
    'Claude などの AI エージェントが、AI ストアのデータ・API・AI への相談を JPYC で都度購入できるようになります。数分のセットアップで、支払いは数円から。',
  backHome: '← トップにもどる',

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

  quickSetupTitle: 'セットアップ A: 手軽に始める (専用ウォレット)',
  quickSetupBody:
    '使う分だけ JPYC を入れた専用の少額ウォレットを作り、その秘密鍵で Claude Desktop に openpay-x402-mcp を設定します。',
  quickSetupConfigLabel: 'Claude Desktop の設定 JSON',
  quickSetupConfig: MCP_CONFIG_JSON,
  privateKeyWarning:
    '注意：秘密鍵は環境変数に平文で置くため、必ず専用・少額のウォレットを使ってください。メインウォレットの鍵は絶対に使わないでください。',

  stewardTitle: 'セットアップ B: 安全に運用する (Steward)',
  stewardBody:
    'AI に鍵を一切見せない構成です。オープンソースの signing 基盤 Steward が鍵を暗号化金庫に保管し、金額上限・宛先許可・監査ログをポリシーで強制します。',
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

  guardsTitle: '守ってくれるもの (金銭ガード)',
  guards: [
    '1 回の支払い上限（既定 10 JPYC）',
    'セッション中の累計支払い上限（既定 100 JPYC）',
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
    'Claude Desktop に限らず、MCP を話せるエージェントフレームワークなら同じ構成で JPYC 購入ができます。AWS の Strands Agents なら、MCPClient に openpay-x402-mcp を渡すだけです。環境変数（署名モード・支払い上限）はセットアップ A/B と共通です。',
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
    'Set up Claude or another AI agent to buy data, APIs, and AI consultations from the AI Store with JPYC. Covers a dedicated low-balance wallet, Steward, money guards, and a real example.',
  title: 'Give your AI the power to pay.',
  subtitle:
    'AI agents such as Claude can buy data, APIs, and consultations with other AIs from the AI Store, paying JPYC per use. Setup takes minutes, and purchases start at just a few yen.',
  backHome: '← Back to home',

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

  quickSetupTitle: 'Setup A: the easy path (dedicated wallet)',
  quickSetupBody:
    'Create a dedicated low-balance wallet funded only with the JPYC you intend to use, then configure openpay-x402-mcp in Claude Desktop with its private key.',
  quickSetupConfigLabel: 'Claude Desktop config JSON',
  quickSetupConfig: MCP_CONFIG_JSON,
  privateKeyWarning:
    'Caution: the private key is stored in plain text in an environment variable. Always use a dedicated low-balance wallet. Never use the key to your primary wallet.',

  stewardTitle: 'Setup B: safer operation (Steward)',
  stewardBody:
    'This setup never exposes the key to the AI. Steward, an open-source signing platform, keeps it in an encrypted vault and enforces amount limits, destination allowlists, and audit logs through policy.',
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

  guardsTitle: 'What protects you (money guards)',
  guards: [
    'Per-payment cap (default: 10 JPYC)',
    'Cumulative session cap (default: 100 JPYC)',
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
    'Any agent framework that speaks MCP can buy in JPYC with the same setup — not just Claude Desktop. With AWS Strands Agents, just hand openpay-x402-mcp to an MCPClient. The environment variables (signer mode, spend limits) are the same as Setup A/B.',
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
