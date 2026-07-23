// /guide/sell「API を売るガイド」の content SOT (ja/en 同梱)。
// page (app/[locale]/guide/sell/page.tsx) が locale で出し分けて描画する。
//
// 設計方針 (lib/agentGuide.ts と同じ):
// - 長文コンテンツは messages/*.json でなく本モジュールに置く。ja/en は本モジュールに同梱する。
// - 描画は既存の PosGuidePieces / AgentGuidePieces を再利用し、この面固有の component は作らない。
// - SDK コードは packages/x402-sdk/README.md の Sell with the SDK と同じ内容を共有する。
// - x402 利用料の表現は messages/*.json と lib/legal.ts の開示に合わせ、売り手の満額着金と
//   買い手上乗せを混同しない。

import type { GuideStep } from './posGuide';

export type SellGuideLocale = 'ja' | 'en';

type SellGuideLink = {
  readonly label: string;
  readonly href: string;
};

const POLYGON_TX =
  '0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249';
const POLYGON_TX_URL = `https://polygonscan.com/tx/${POLYGON_TX}`;
const NOTE_URL = 'https://note.com/masia02/n/nf891b56872b4';
const GATEWAY_URL = 'https://github.com/cipherwebllc/x402-jpyc-gateway';
const SDK_NPM_URL = 'https://www.npmjs.com/package/openpay-x402-sdk';

const NO_CODE_ENV = [
  'ADAPTER=http',
  'UPSTREAM_URL=https://your-api.example.com',
  'MY_RESOURCE_URL=https://your-gate.example.com',
].join('\n');

const SDK_INSTALL = 'npm install openpay-x402-sdk';

const SDK_ONE_SHOT = [
  "import { createJpycGate } from 'openpay-x402-sdk';",
  '',
  'const gate = createJpycGate({',
  '  resourceUrl: process.env.MY_RESOURCE_URL,',
  '});',
  '',
  'export async function GET(request) {',
  '  const payment = await gate.handle(request);',
  '  if (payment instanceof Response) return payment;',
  '',
  "  const response = Response.json({ your: 'paid content' });",
  '  response.headers.set(',
  "    'X-PAYMENT-RESPONSE',",
  '    payment.paymentResponseHeader,',
  '  );',
  '  return response;',
  '}',
].join('\n');

const SDK_SPLIT = [
  'export async function GET(request) {',
  '  const payment = await gate.verify(request);',
  '  if (payment instanceof Response) return payment;',
  '',
  '  let data;',
  '  try {',
  '    data = await callUpstream();',
  '  } catch {',
  "    return Response.json({ error: 'upstream_failed' }, { status: 502 });",
  '  }',
  '',
  '  const settlement = await payment.settle();',
  '  if (settlement instanceof Response) return settlement;',
  '',
  '  const response = Response.json(data);',
  '  response.headers.set(',
  "    'X-PAYMENT-RESPONSE',",
  '    settlement.paymentResponseHeader,',
  '  );',
  '  return response;',
  '}',
].join('\n');

export type SellGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly title: string;
  readonly subtitle: string;
  readonly backHome: string;

  readonly proofTitle: string;
  readonly proofIntro: string;
  readonly proofFlow: string;
  readonly proofTransaction: SellGuideLink;
  readonly proofOutcome: string;
  readonly proofArticleLead: string;
  readonly proofArticle: SellGuideLink;

  readonly routesTitle: string;
  readonly routesIntro: string;
  readonly noCodeTitle: string;
  readonly noCodeBody: string;
  readonly noCodeLink: SellGuideLink;
  readonly noCodeEnvLabel: string;
  readonly noCodeEnv: string;
  readonly sdkTitle: string;
  readonly sdkBody: string;
  readonly sdkPackage: SellGuideLink;
  readonly sdkInstallLabel: string;
  readonly sdkInstall: string;
  readonly sdkOneShotLabel: string;
  readonly sdkOneShotCode: string;
  readonly sdkSplitIntro: string;
  readonly sdkSplitLabel: string;
  readonly sdkSplitCode: string;
  readonly sdkSplitNote: string;
  readonly snippetTitle: string;
  readonly snippetBody: string;
  readonly snippetLink: SellGuideLink;
  readonly authorityTitle: string;
  readonly authorityBody: string;

  readonly listingTitle: string;
  readonly listingSteps: readonly GuideStep[];
  readonly registrationLink: SellGuideLink;

  readonly jobDescTitle: string;
  readonly jobDescIntro: string;
  readonly jobDescItems: readonly string[];
  readonly jobDescExampleLabel: string;
  readonly jobDescExample: string;

  readonly qualityTitle: string;
  readonly quality: readonly string[];

  readonly pricingTitle: string;
  readonly pricingIntro: string;
  readonly pricingExamples: readonly string[];
  readonly pricingAdvice: string;
  readonly pricingGuard: string;

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaButton: string;
  readonly ctaButtonHref: string;
  readonly buyerGuideLead: string;
  readonly buyerGuideLink: SellGuideLink;
};

const ja: SellGuideContent = {
  metaTitle: 'API を売るガイド — 402 ゲートで AI ストアに出品',
  metaDescription:
    '既存 API や AI エージェントを 402 ゲートで JPYC 課金化し、OpenPay の AI ストアに無料掲載する手順。SDK、コピペスニペット、ノーコードゲートウェイと実売事例を紹介します。',
  title: 'API を、AI が買える商品にする',
  subtitle:
    '402 ゲートを 1 つ立てて AI ストアに掲載すると、Claude などの AI エージェントが JPYC で都度購入できます。掲載無料・売上は満額直接着金。利用料は決済額の 1%（最低 1 JPYC）・支払う側の上乗せです。ノンカストディ。',
  backHome: '← トップにもどる',

  proofTitle: '実売の証拠',
  proofIntro:
    '2026 年 7 月、Internet Computer 上の AI エージェント Coo-ICP を本ガイドの手順で出品し、Claude（買い手 MCP）が 1 相談 2 JPYC（本体 1 JPYC + 利用料 1 JPYC）で実購入しました。',
  proofFlow:
    '402 → JPYC 決済 → 解錠の一周はオンチェーンで検証できます。Polygon tx:',
  proofTransaction: {
    label: POLYGON_TX,
    href: POLYGON_TX_URL,
  },
  proofOutcome:
    'Coo-ICP 本体は 1 行も変更せず、前段の 402 ゲートウェイだけで商品化しました。',
  proofArticleLead: '実装から初回販売までの詳しい読み物:',
  proofArticle: {
    label: 'note のケーススタディを読む',
    href: NOTE_URL,
  },

  routesTitle: '出品の 3 経路',
  routesIntro:
    '既存 API をどこまで触れるかに合わせて、難易度の低い順に選べます。',
  noCodeTitle: 'ノーコード（推奨・5 分）',
  noCodeBody:
    'x402-jpyc-gateway の「Deploy with Vercel」からデプロイし、次の env を 3 つ設定します。既存 API は変更ゼロで課金化できます。',
  noCodeLink: {
    label: 'x402-jpyc-gateway を GitHub で開く',
    href: GATEWAY_URL,
  },
  noCodeEnvLabel: 'Vercel に設定する env',
  noCodeEnv: NO_CODE_ENV,
  sdkTitle: 'SDK（数行）',
  sdkBody:
    'openpay-x402-sdk をインストールし、登録する正確な resourceUrl で createJpycGate({ resourceUrl }) を作ります。',
  sdkPackage: {
    label: 'openpay-x402-sdk を npm で開く',
    href: SDK_NPM_URL,
  },
  sdkInstallLabel: 'インストール',
  sdkInstall: SDK_INSTALL,
  sdkOneShotLabel: '一発型: gate.handle(request)',
  sdkOneShotCode: SDK_ONE_SHOT,
  sdkSplitIntro:
    '安価な処理は handle() で検証と精算を一度に行えます。高コストな本体処理は verify() で先に検証し、本体処理が成功してから settle() します。',
  sdkSplitLabel: '分割型: verify() → 本体処理 → settle()',
  sdkSplitCode: SDK_SPLIT,
  sdkSplitNote:
    '本体処理または決済に失敗したときは、有料データを返しません。買い手に課金せず本体処理の失敗を返すには、settle() の前にエラー応答を返します。',
  snippetTitle: 'コピペスニペット（依存ゼロ）',
  snippetBody:
    'AI ストアの登録フォームには、Node 18+ で動く自己完結の 402 ゲートスニペットがあります。依存パッケージを増やさず、そのまま既存 API の前段に置けます。',
  snippetLink: {
    label: '登録フォームでスニペットを見る',
    href: '/discovery',
  },
  authorityTitle: '3 経路に共通すること',
  authorityBody:
    '価格・利用料・受取先はコードに書きません。カタログの accepts が唯一の権威で、ゲートは自動追従します。',

  listingTitle: '掲載手順',
  listingSteps: [
    {
      n: 1,
      title: 'ゲートをデプロイ',
      body: 'AI ストアへの掲載前は、カタログに accepts がまだ無いため HTTP 500 になります。これは正常な bootstrap 状態です。',
    },
    {
      n: 2,
      title: 'AI ストアで登録',
      body: 'ウォレット接続（SIWE）後、URL、価格（JPYC の整数）、説明、カテゴリ、Docs URL、利用条件・正当性表明を入力します。説明はエージェントが読む前提で、何が返るかを淡々と書きます。',
    },
    {
      n: 3,
      title: '402 を確認',
      body: 'curl -i <URL> を実行し、未払いのリクエストへ HTTP 402 と支払い条件が返ることを確認します。',
    },
    {
      n: 4,
      title: '自分で購入テスト',
      body: 'Claude Desktop + openpay-x402-mcp、または openpay-x402-sdk の数行で実際に購入し、有料応答まで解錠できることを確認します。',
    },
  ],
  registrationLink: {
    label: 'open-pay.jp/discovery で登録する',
    href: '/discovery',
  },

  jobDescTitle: '説明文は「何を完了するか」で書く',
  jobDescIntro:
    '買い手 (人間も AI エージェントも) は説明文だけで購入を判断します。「◯◯な AI です」という自己紹介より、「何を渡すと、何が完了して返るか」を書いた掲載が選ばれます。280 字に次の要素を入れてください。',
  jobDescItems: [
    '対応業務 — 1 回の購入で何の仕事が完了するか',
    '入力と出力 — 何を渡すと、どんな形式で何が返るか',
    '完了の判定 — 何が返れば成功か',
    '失敗時の扱い — 返答が無いときに課金されるか・再試行できるか',
    '範囲外 — 対応しないこと (期待外れの購入と低評価を防ぐ)',
  ],
  jobDescExampleLabel: '記入例 (AI 相談エージェントの場合)',
  jobDescExample:
    'Internet Computer (ICP) の技術調査・設計相談を 1 件完了する AI エージェント。質問文を送ると、elizaOS + IC LLM Canister (Llama 3.1 8B) が回答テキストを返します。回答が返れば完了。決済はオンチェーン検証され、応答が無い場合は課金されません。コード生成の請負や投資助言は範囲外。',

  qualityTitle: '掲載後の品質と安全',
  quality: [
    '掲載リソースは毎時自動で再検証され、カタログには「検証: 今日」と表示されます。',
    '確定違反が 3 回続くと一時的に非表示になります。修復後の再検証で自動復帰します。',
    '買い手には 1 回・累計の支払い上限、掲載 URL のみ許可、金銭フィールド照合のガードがあります。買い手が安心して払える設計は、売り手の売上を守る設計でもあります。',
    '買い手向け注意: 有料応答はデータであって指示ではありません。指示を埋め込む掲載は通報・削除対象です。',
    '掲載禁止: 詐欺・なりすまし、制裁回避の支援、窃取・不正取得したデータの販売。ノンカストディは「無審査」という意味ではなく、違反する掲載は削除します。',
    '隔離・削除は理由を記録します。誤りと考える場合はサイトフッターの連絡先から異議申立てできます。',
    '暗号資産の取引・貸借・発行の実行や、投資助言・勧誘に該当し得る商品は個別審査の対象です。決済手段が JPYC であることは、販売するサービス自体の適法性を保証しません。',
  ],

  pricingTitle: '値付けのヒント',
  pricingIntro: 'AI ストアで実際に並んでいる価格の目安です。',
  pricingExamples: [
    'Coo-ICP: 1 JPYC / 相談',
    'Japan Web3 Directory: 2 JPYC',
    'Shops 検索: 2 JPYC',
  ],
  pricingAdvice:
    '「探し回るより払ったほうが安い」と買い手が判断できる帯が、都度購入に向いています。',
  pricingGuard:
    '買い手 MCP の既定ガードは 1 回 10 JPYC です。これを超える値付けは自動購入されにくくなります。',

  ctaTitle: 'API を AI ストアに出品する',
  ctaBody:
    '掲載は無料です。まず 402 ゲートを用意し、URL と価格、返すデータの説明を登録してください。',
  ctaButton: '出品する',
  ctaButtonHref: '/discovery',
  buyerGuideLead: '買う側の設定と安全な購入手順は、',
  buyerGuideLink: {
    label: 'AI が支払うガイド',
    href: '/guide/ai-pay',
  },
};

const en: SellGuideContent = {
  metaTitle: 'Sell your API — add a 402 gate and list it in the AI Store',
  metaDescription:
    'Monetize an existing API or AI agent in JPYC with a 402 gate and list it in the OpenPay AI Store for free. Includes SDK, copy-paste, no-code paths, and a real sale case study.',
  title: 'Turn your API into a product AI can buy',
  subtitle:
    "Put up one 402 gate and list it in the AI Store, and AI agents such as Claude can buy it per request with JPYC. Listing is free, and the full listed price settles directly to you. The fee is 1% of the payment (minimum 1 JPYC), added on the payer's side. Non-custodial.",
  backHome: '← Back to home',

  proofTitle: 'Proof of a real sale',
  proofIntro:
    'In July 2026, Coo-ICP, an AI agent on Internet Computer, was listed by following this guide. Claude (through the buyer MCP) made a real purchase at 2 JPYC per consultation (1 JPYC price + 1 JPYC usage fee).',
  proofFlow:
    'The complete 402 → JPYC payment → unlock cycle can be verified on-chain. Polygon tx:',
  proofTransaction: {
    label: POLYGON_TX,
    href: POLYGON_TX_URL,
  },
  proofOutcome:
    'Not one line of Coo-ICP itself changed. Only the 402 gateway in front of it was needed to turn it into a product.',
  proofArticleLead: 'Read the full story from implementation to first sale:',
  proofArticle: {
    label: 'Read the case study on note',
    href: NOTE_URL,
  },

  routesTitle: 'Three ways to list',
  routesIntro:
    'Choose by how much of the existing API you can change, starting with the easiest path.',
  noCodeTitle: 'No code (recommended · 5 minutes)',
  noCodeBody:
    'Use “Deploy with Vercel” from x402-jpyc-gateway, then set the three env values below. Your existing API needs no changes.',
  noCodeLink: {
    label: 'Open x402-jpyc-gateway on GitHub',
    href: GATEWAY_URL,
  },
  noCodeEnvLabel: 'Env values to set in Vercel',
  noCodeEnv: NO_CODE_ENV,
  sdkTitle: 'SDK (a few lines)',
  sdkBody:
    'Install openpay-x402-sdk and create createJpycGate({ resourceUrl }) with the exact resource URL you register.',
  sdkPackage: {
    label: 'Open openpay-x402-sdk on npm',
    href: SDK_NPM_URL,
  },
  sdkInstallLabel: 'Install',
  sdkInstall: SDK_INSTALL,
  sdkOneShotLabel: 'One-shot: gate.handle(request)',
  sdkOneShotCode: SDK_ONE_SHOT,
  sdkSplitIntro:
    'For inexpensive work, handle() verifies and settles in one call. For an expensive operation, verify first, run the operation, and call settle() only after it succeeds.',
  sdkSplitLabel: 'Split: verify() → operation → settle()',
  sdkSplitCode: SDK_SPLIT,
  sdkSplitNote:
    'Do not return paid data when the operation or settlement fails. To leave the buyer uncharged after an operation failure, return the error before calling settle().',
  snippetTitle: 'Copy-paste snippet (zero dependencies)',
  snippetBody:
    'The AI Store registration form provides a self-contained 402 gate snippet for Node 18+. Put it in front of your existing API without adding a dependency.',
  snippetLink: {
    label: 'See the snippet in the registration form',
    href: '/discovery',
  },
  authorityTitle: 'What all three paths share',
  authorityBody:
    'Do not put the price, usage fee, or recipient in code. The catalog accepts entry is the sole authority, and the gate follows it automatically.',

  listingTitle: 'Listing steps',
  listingSteps: [
    {
      n: 1,
      title: 'Deploy the gate',
      body: 'Before the AI Store listing exists, the catalog has no accepts entry, so HTTP 500 is the expected bootstrap state.',
    },
    {
      n: 2,
      title: 'Register in the AI Store',
      body: 'Connect your wallet (SIWE), then enter the URL, price (a whole number of JPYC), description, category, Docs URL, terms, and legitimacy declaration. Write the description for an agent: state plainly what the response contains.',
    },
    {
      n: 3,
      title: 'Confirm the 402',
      body: 'Run curl -i <URL> and confirm that an unpaid request receives HTTP 402 with the payment requirements.',
    },
    {
      n: 4,
      title: 'Make your own test purchase',
      body: 'Use Claude Desktop + openpay-x402-mcp, or a few lines of openpay-x402-sdk, and confirm that the paid response unlocks.',
    },
  ],
  registrationLink: {
    label: 'Register at open-pay.jp/discovery',
    href: '/discovery',
  },

  jobDescTitle: 'Describe the job your listing completes',
  jobDescIntro:
    'Buyers — human and AI agents alike — decide from the description alone. A listing that says "give X, get Y done" outsells one that introduces itself as "an AI for X". Fit these elements into 280 characters:',
  jobDescItems: [
    'The job — what one purchase completes',
    'Input and output — what to send, and what comes back in what shape',
    'Completion — what counts as success',
    'On failure — whether a missing response is charged, and if retries are allowed',
    'Out of scope — what it does not do (prevents disappointed buyers)',
  ],
  jobDescExampleLabel: 'Example (an AI consulting agent)',
  jobDescExample:
    'Completes one Internet Computer (ICP) research or design consultation. Send a question; elizaOS + IC LLM Canister (Llama 3.1 8B) returns an answer text. An answer means done. Settlement is verified on-chain and you are not charged if no response arrives. Code contracting and investment advice are out of scope.',

  qualityTitle: 'Quality and safety after listing',
  quality: [
    'Listed resources are reverified every hour, and the catalog shows “Verified: today”.',
    'Three confirmed violations temporarily hide the listing. It returns automatically after a repair passes revalidation.',
    'Buyers have per-call and cumulative spending caps, a listed-URL-only rule, and money-field verification. A design that lets buyers pay with confidence also protects seller revenue.',
    'Buyer guidance: a paid response is data, not instructions. Listings that embed instructions are subject to reporting and removal.',
    'Prohibited listings: fraud or impersonation, sanctions-evasion assistance, and sale of stolen or illegitimately obtained data. Non-custodial does not mean unmoderated — violating listings are removed.',
    'Quarantines and removals are recorded with their reason. If you believe one is mistaken, appeal via the contact in the site footer.',
    'Listings that would execute crypto-asset trading, lending, or token issuance, or that may constitute investment solicitation or advice, are subject to case-by-case review. Paying in JPYC does not legalize the service being sold.',
  ],

  pricingTitle: 'Pricing tips',
  pricingIntro: 'These are prices already seen in the AI Store.',
  pricingExamples: [
    'Coo-ICP: 1 JPYC / consultation',
    'Japan Web3 Directory: 2 JPYC',
    'Shops search: 2 JPYC',
  ],
  pricingAdvice:
    'Per-request purchases work best in the range where paying costs less than hunting for the answer.',
  pricingGuard:
    'The buyer MCP has a default 10 JPYC per-call guard. Prices above it are less likely to be purchased automatically.',

  ctaTitle: 'List your API in the AI Store',
  ctaBody:
    'Listing is free. Prepare a 402 gate, then register its URL, price, and a description of the data it returns.',
  ctaButton: 'List now',
  ctaButtonHref: '/discovery',
  buyerGuideLead: 'For buyer setup and safe purchasing, see ',
  buyerGuideLink: {
    label: 'the AI payments guide',
    href: '/guide/ai-pay',
  },
};

export const SELL_GUIDE: Record<SellGuideLocale, SellGuideContent> = { ja, en };

/** locale 文字列を SellGuideLocale へ正規化 (未知は ja)。 */
export function sellGuideContentFor(locale: string): SellGuideContent {
  return locale === 'en' ? SELL_GUIDE.en : SELL_GUIDE.ja;
}

/** /guide/sell の <title>/<description> を組み立てる (page の generateMetadata が利用)。 */
export function guideSellMetadata(locale: string): {
  title: string;
  description: string;
} {
  const c = sellGuideContentFor(locale);
  return { title: `${c.metaTitle} · OpenPay`, description: c.metaDescription };
}
