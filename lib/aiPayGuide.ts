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
    'Claude などの AI エージェントが、AI ストアのデータ・API・AI への相談を JPYC で都度購入できるようになります。数分のセットアップで、支払いは数円から。',
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
  quickSetupTitle: 'セットアップ A: 手軽に始める (ローカルウォレット)',
  quickSetupBody:
    '秘密鍵を設定に貼る必要はありません。下の設定を Claude Desktop に追加して再起動し、AI に「wallet_init を呼んで」と頼むと、MCP があなたのマシン上に専用ウォレットを作り、アドレスと入金用のリンクだけを返します。そのアドレスへ使う分だけ JPYC を送れば、支払いが有効になります。残高は入金用のリンク (Agent ページ) で、支払い上限は wallet_status で確認できます。',
  quickSetupConfigLabel: 'Claude Desktop の設定 JSON',
  quickSetupConfig: MCP_CONFIG_JSON,
  privateKeyWarning:
    '注意：鍵はあなたのマシンのファイル（~/.openpay-x402/wallet.json）に平文で保存されます。会話にも OpenPay にも出ませんが、あなたとしてコマンドを実行できるもの（シェルを使える AI エージェントを含む）はこの鍵を読めます。入れるのは失ってもよい少額だけにしてください。OpenPay は鍵を復元できません。',

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
    '鍵を自分の PC に置かず、Kova (Komlock lab) または MetaMask Agent Wallet の server wallet に署名だけを頼む構成です。OpenPay はどちらの鍵も資格情報も受け取りません。MCP の設定は SIGNER_MODE=kova または SIGNER_MODE=metamask と公開アドレス (Kova は wallet 名も) だけで、Agent ページの設定生成から作れます。ウォレットの作成やログインは、あなた自身がそれぞれの CLI で行います。',
  thirdPartyFacts: [
    '実測で分かっていること: Kova (0.1.2) と MetaMask Agent Wallet (7.0.0) の policy (許可チェーン・送金上限) は、この支払い方式で使う署名には効きませんでした。金額の上限として効くのは MCP の設定 (下の金銭ガード) だけです。',
    '「第三者の wallet なら安心」ではなく、「鍵を PC に置かない」ための選択肢です。そのマシンで CLI にログイン済みなら、CLI から MCP の上限を経ずに直接署名・送金できます。入れるのは失ってもよい少額だけにしてください。',
    'スマホの Claude アプリの Code やブラウザ版 Claude Code のような使い捨てのクラウド環境では使えません。CLI とログイン状態が MCP と同じマシンに要るためです。',
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
    'Set up Claude or another AI agent to buy data, APIs, and AI consultations from the AI Store with JPYC. Covers a dedicated low-balance wallet, Kova / MetaMask Agent Wallet, Steward, money guards, and a real example.',
  title: 'Give your AI the power to pay.',
  subtitle:
    'AI agents such as Claude can buy data, APIs, and consultations with other AIs from the AI Store, paying JPYC per use. Setup takes minutes, and purchases start at just a few yen.',
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
  quickSetupTitle: 'Setup A: the easy path (local wallet)',
  quickSetupBody:
    'You never paste a private key into the config. Add the config below to Claude Desktop, restart it, and ask your AI to “call wallet_init”. The MCP creates a dedicated wallet on your machine and returns only its address and a funding link. Send just the JPYC you intend to use to that address and paying is enabled. Check the balance via the funding link (the Agent page) and the spending limits with wallet_status.',
  quickSetupConfigLabel: 'Claude Desktop config JSON',
  quickSetupConfig: MCP_CONFIG_JSON,
  privateKeyWarning:
    'Caution: the key is stored in plain text in a file on your machine (~/.openpay-x402/wallet.json). It never enters the chat or reaches OpenPay, but anything that can run commands as you — including an AI agent with shell access — can read it. Fund it only with a small amount you can afford to lose. OpenPay cannot recover the key.',

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
    'Keep the key off your PC and let a Kova (Komlock lab) wallet or a MetaMask Agent Wallet server wallet sign only. OpenPay never receives either key or any credentials. The MCP config is just SIGNER_MODE=kova or SIGNER_MODE=metamask plus the public address (and the wallet name for Kova); the Agent page config generator builds it. You create the wallet and sign in with each CLI yourself.',
  thirdPartyFacts: [
    'What our tests showed: the Kova (0.1.2) and MetaMask Agent Wallet (7.0.0) policies (allowed chains, outflow limits) did not apply to the signature this payment method uses. The only amount caps that apply are the MCP settings (the money guards below).',
    'This is not “a third-party wallet makes it safe” but “keep the key off the PC”. A CLI already signed in on that machine can sign or send directly, bypassing the MCP caps. Fund it only with a small amount you can afford to lose.',
    'It does not work in disposable cloud environments such as the Claude mobile app’s Code tab or Claude Code on the web, because the CLI and its login must live on the same machine as the MCP.',
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
