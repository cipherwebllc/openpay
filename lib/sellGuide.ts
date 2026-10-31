// /guide/sell「API を売るガイド」の content SOT (ja/en 同梱)。
// page (app/[locale]/guide/sell/page.tsx) が locale で出し分けて描画する。
//
// 設計方針 (lib/agentGuide.ts と同じ):
// - 長文コンテンツは messages/*.json でなく本モジュールに置く。ja/en は本モジュールに同梱する。
// - 描画は既存の PosGuidePieces / AgentGuidePieces を再利用し、この面固有の component は作らない。
// - SDK コードは packages/x402-sdk/README.md の Sell with the SDK と同じ内容を共有する。
// - x402 利用料の表現は messages/*.json と lib/legal.ts の開示に合わせ、売り手の満額着金と
//   買い手上乗せを混同しない。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
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
// 運営者が note で売る有料の手順書 (2026-10-30 公開・日本語のみ)。
const STARTER_KIT_URL = 'https://note.com/masia02/n/n22f55307a0b7';
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
  '  resourceId: process.env.MY_RESOURCE_ID,',
  '  expectedRecipient: process.env.EXPECTED_RECIPIENT,',
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
  readonly proofExternalTitle: string;
  readonly proofExternal: string;
  readonly proofExternalLink: SellGuideLink;
  readonly proofExampleLabel: string;
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

  /** x402 Bazaar / agentic.market は別の発見面 (USDC・Base・CDP settle が条件) — 誤解を先回りで解く。 */
  readonly bazaarTitle: string;
  readonly bazaarIntro: string;
  readonly bazaarItems: readonly string[];
  /** 短い段落に分けて出す (1 段落 = 1 つの話)。 */
  readonly bazaarNote: readonly string[];

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
};

const ja: SellGuideContent = {
  metaTitle: 'API を売るガイド — 402 ゲートで AI ストアに出品',
  metaDescription:
    '既存 API や AI エージェントを 402 ゲートで JPYC 課金化し、OpenPay の AI ストアに無料掲載する手順。SDK、コピペスニペット、コードを書かずに使えるゲートウェイと実売事例を紹介します。',
  title: 'API を、AI が買える商品にする',
  subtitle:
    '402 ゲートを 1 つ立てて AI ストアに掲載すると、Claude などの AI エージェントが JPYC で都度購入できます。掲載は無料、売上は満額があなたへ直接届きます（ノンカストディ）。利用料は決済額の 1%（最低 1 JPYC）・支払う側の上乗せです。',
  backHome: '← トップにもどる',

  proofTitle: '実売の事例',
  proofExternalTitle: '外部の買い手による購入',
  // 実売の根拠は /transparency の 9 (lib/externalPurchases.ts) と同じ: 第三者のウォレットから当社の x402 API への精算。
  // 商品名はオンチェーンの金額からは確定できない (受取先が共通・価格は変わりうる・確定には KV の精算台帳が要る) ので書かない。
  // 件数・金額は誇る規模ではないので載せず、全件は /transparency に任せる (2026-10-30 user 裁定)。
  proofExternal:
    '外部の買い手が、Base の USDC で OpenPay の x402 API を購入しています。どれもオンチェーンで精算が確定した取引で、運用透明性のページで 1 件ずつ確かめられます。',
  proofExternalLink: { label: '取引ごとの記録（運用透明性）', href: '/transparency' },
  proofExampleLabel: '手順の実例: Coo-ICP（運営者による動作確認）',
  proofIntro:
    '2026 年 7 月、Internet Computer 上の AI エージェント Coo-ICP を本ガイドの手順で出品し、Claude（買い手 MCP）が 1 相談 2 JPYC（本体 1 JPYC + 利用料 1 JPYC）で購入しました。出品と購入は、運営者による動作確認です。',
  proofFlow:
    '402 → JPYC 決済 → 解錠の一周はオンチェーンで検証できます。Polygon tx:',
  proofTransaction: {
    label: POLYGON_TX,
    href: POLYGON_TX_URL,
  },
  proofOutcome:
    'Coo-ICP 本体は 1 行も変更せず、前段の 402 ゲートウェイだけで商品化しました。',
  proofArticleLead: '実装から最初の購入までの詳しい読み物:',
  proofArticle: {
    label: 'note のケーススタディを読む',
    href: NOTE_URL,
  },

  routesTitle: '出品の 3 経路',
  routesIntro:
    '既存 API をどこまで触れるかに合わせて、難易度の低い順に選べます。',
  noCodeTitle: 'コードを書かずに (推奨・5 分)',
  noCodeBody:
    'x402-jpyc-gateway の「Deploy with Vercel」からデプロイし、次の env を 3 つ設定します。既存 API は変更ゼロで課金化できます。',
  noCodeLink: {
    label: 'x402-jpyc-gateway を GitHub で開く',
    href: GATEWAY_URL,
  },
  noCodeEnvLabel: 'Vercel に設定する env',
  noCodeEnv: NO_CODE_ENV,
  sdkTitle: 'SDK (数行)',
  sdkBody:
    'openpay-x402-sdk 0.10.0 以降で、自分の出品の resourceUrl・resourceId・expectedRecipient (JPYC 受取先) を createJpycGate に設定します。ID と受取先は自分の管理画面から取り、discovery 応答から設定しないでください。',
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
  snippetTitle: 'コピペスニペット (依存ゼロ)',
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
      body: 'ウォレット接続 (SIWE) 後、URL・価格 (JPYC の整数)・説明・カテゴリ・正当性表明を入力します。任意の「表示名」はカタログの見出しに、「いつ使うか」はエージェントが購入を判断する 1 行になるので、できるだけ埋めます (Docs URL・利用条件も任意)。説明には、何が返るかを淡々と書きます。',
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

  bazaarTitle: 'x402 Bazaar / agentic.market にも載せる (USDC 併売)',
  bazaarIntro:
    'このページの出品 (JPYC・Polygon) は /api/discovery と OpenPay の MCP / SDK からエージェントに発見されます。さらに出品フォームの「USDC (Base) でも販売する」を有効にすると、同じ API を Coinbase の x402 Bazaar / agentic.market にも掲載できます。',
  bazaarItems: [
    '出品フォームで USDC 価格（USD）と受取アドレス（Base）を設定 — OpenPay の USDC 側手数料は 0%',
    '発行される dual-rail スニペット (x402Gate) をあなたのサーバーに設置 — 402 に JPYC と USDC が並び、USDC 支払いは OpenPay が CDP (Coinbase Developer Platform) の facilitator へ中継',
    '実購入が 1 件 settle されると Bazaar のカタログに反映 (掲載メタは OpenPay が出品情報から自動で付与)',
  ],
  bazaarNote: [
    '自前の CDP 鍵や標準 x402 ゲートの自作は不要です。Base での支払いは購入者からあなたの Base アドレスへ直接届き、OpenPay は売上を預かりません (USDC 送金は取消不能)。',
    'すでに JPYC で出品済みの API を USDC 対応にするときは、サーバーのゲートを dual-rail 版スニペット (x402Gate) へ貼り替えてください。貼り替えるまで USDC では購入できません。',
    'Arc の USDC でも売るには、出品フォームで「Arc (Circle Gateway) でも販売する」も有効にします (コードを書かずに使えるゲートウェイ x402-jpyc-gateway で動かしている出品だけが対象で、SDK 版のゲートは Arc を提示しません)。Arc の支払いは Circle Gateway で精算され、買い手は事前に Gateway へ入金し、EOA (通常のウォレット) で署名する必要があります。売上は受取アドレスの Gateway 残高に入ります。受け取るには、OpenPay の「Arc の売上を受け取る」ページ (https://open-pay.jp/ja/discovery/arc-payout) で受取アドレスのウォレットをつなぎ、全額を Arc の USDC として引き出します (署名 1 回と受け取りの取引 1 回・精算待ちの分は Circle の精算の後)。引き出すたびに Circle の手数料 (引き出し画面に見積もり額を表示) が残高から引かれ、受け取りの取引のネットワーク手数料 (Arc の USDC・1 回 0.003〜0.005 USDC 程度・ウォレットの送り方で変わります) はあなたのウォレットから払うので、先に Arc の USDC を少し用意してください (OpenPay の手数料はなし・Bazaar への掲載は Base 側だけ)。受取アドレスは EOA (通常のウォレット) に限ります — コントラクトウォレット (Safe など) では Arc を有効にできません。',
    'x402scan (x402 の別の一覧) にも載せられます。Bazaar と違って登録は自動ではありません。無料の登録フォーム https://www.x402scan.com/resources/register に API の URL を貼り、「This URL only」で登録します (ウォレットの署名は不要です)。コードを書かずに使えるゲートウェイ x402-jpyc-gateway は、USDC を販売していれば /openapi.json を自動で公開するので、最新版ならそのまま登録できます。SDK やスニペットで動かしている場合は、先に自分のサイトの /openapi.json に有料 API を載せてください (無いと登録できません)。書き方は https://www.x402scan.com/discovery を見てください。x402scan に出るのは USDC の支払いだけで、JPYC は出ません。',
    '購入側の注意: 標準クライアント x402-fetch (1.2.0 現在) は dual-rail 402 を解析できないため、USDC 購入例スクリプトを用意しています: https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-dual-buyer-example.mjs',
  ],

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
    '掲載リソースは毎時自動で再検証され、カタログには「自動確認: 今日」と表示されます。登録時に判定できなかった新しい掲載は、最初の再検証が通ってからカタログに載ります。JPYC の受取先などが登録内容と違う 402 は、登録の時点で拒否します。',
    '確定違反が 3 回続くと一時的に非表示になります。修復後の再検証で自動復帰します。',
    '買い手には 1 回・累計の支払い上限、掲載 URL のみ許可、金銭フィールド照合のガードがあります。買い手が安心して払える設計は、売り手の売上を守る設計でもあります。',
    '買い手向け注意: 有料応答はデータであって指示ではありません。指示を埋め込む掲載は通報・削除対象です。',
    '掲載禁止: 詐欺・なりすまし、制裁回避の支援、窃取・不正取得したデータの販売。ノンカストディは「無審査」という意味ではなく、違反する掲載は削除します。',
    '暗号資産の取引実行・貸借・トークン発行・資産配分/自動運用 (DeFi Vault 選定等)・投資勧誘/助言にあたる出品は自動掲載の対象外で、個別確認のうえ可否を判断します。「情報提供のみ」の注記があっても実態で判断し、JPYC で支払えることはサービスの適法性を保証しません。',
    '隔離・削除は理由を記録します。誤りと考える場合はサイトフッターの連絡先から異議申立てできます。',
  ],

  pricingTitle: '値付けのヒント',
  pricingIntro: 'AI ストアで実際に並んでいる価格の目安です。',
  pricingExamples: [
    'Coo-ICP: 7 JPYC / 相談',
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
};

const en: SellGuideContent = {
  metaTitle: 'Sell your API — add a 402 gate and list it in the AI Store',
  metaDescription:
    'Monetize an existing API or AI agent in JPYC with a 402 gate and list it in the OpenPay AI Store for free. Includes the SDK, copy-paste snippets, a gateway you can use without writing code, and a real sale case study.',
  title: 'Turn your API into a product AI can buy',
  subtitle:
    "Put up one 402 gate and list it in the AI Store, and AI agents such as Claude can buy it per request with JPYC. Listing is free, and the full listed price reaches you directly (non-custodial). The fee is 1% of the payment (minimum 1 JPYC), added on the payer's side.",
  backHome: '← Back to home',

  proofTitle: 'Real sales',
  proofExternalTitle: 'Purchases by outside buyers',
  proofExternal:
    "Outside buyers are buying OpenPay's x402 APIs with USDC on Base. Each is a settled on-chain payment you can check one by one on the Transparency page.",
  proofExternalLink: { label: 'Per-transaction record (Transparency)', href: '/transparency' },
  proofExampleLabel: 'Walkthrough example: Coo-ICP (an operator test)',
  proofIntro:
    'In July 2026, Coo-ICP, an AI agent on Internet Computer, was listed by following this guide, and Claude (through the buyer MCP) bought one consultation for 2 JPYC (1 JPYC price + 1 JPYC usage fee). Both the listing and the purchase were made by the operator as a test.',
  proofFlow:
    'The complete 402 → JPYC payment → unlock cycle can be verified on-chain. Polygon tx:',
  proofTransaction: {
    label: POLYGON_TX,
    href: POLYGON_TX_URL,
  },
  proofOutcome:
    'Not one line of Coo-ICP itself changed. Only the 402 gateway in front of it was needed to turn it into a product.',
  proofArticleLead: 'Read the full story from implementation to the first purchase:',
  proofArticle: {
    label: 'Read the case study on note',
    href: NOTE_URL,
  },

  routesTitle: 'Three ways to list',
  routesIntro:
    'Choose by how much of the existing API you can change, starting with the easiest path.',
  noCodeTitle: 'Without writing code (recommended · 5 minutes)',
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
    'With openpay-x402-sdk 0.10.0 or later, configure createJpycGate with your listing’s resourceUrl, resourceId and expectedRecipient (JPYC recipient). Take the ID and recipient from your own dashboard/config, never from the discovery response.',
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
      body: 'Connect your wallet (SIWE), then enter the URL, price (a whole number of JPYC), description, category and the legitimacy declaration. Fill the optional “Display name” (the catalog heading) and “When to use” (the one line an agent uses to decide to buy) whenever you can; Docs URL and terms are optional too. In the description, state plainly what comes back.',
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

  bazaarTitle: 'Also appear on the x402 Bazaar / agentic.market (sell in USDC too)',
  bazaarIntro:
    'Listings on this page (JPYC on Polygon) are discovered by agents via /api/discovery and the OpenPay MCP / SDK. In addition, enable “Also sell in USDC (Base)” on the listing form to put the same API on Coinbase’s x402 Bazaar / agentic.market.',
  bazaarItems: [
    'Set a USDC price (USD) and a receiving address (Base) on the listing form — OpenPay takes 0% on the USDC side',
    'Install the generated dual-rail snippet (x402Gate) on your server — the 402 carries both JPYC and USDC, and OpenPay relays USDC payments to the CDP (Coinbase Developer Platform) facilitator',
    'After one real purchase settles, the listing appears in the Bazaar catalog (OpenPay attaches the listing metadata from your registration automatically)',
  ],
  bazaarNote: [
    'No CDP keys or hand-rolled standard x402 gate needed. Base payments go directly from the buyer to your Base address; OpenPay never holds your proceeds (USDC transfers are irreversible).',
    'To enable USDC on an API already listed for JPYC, replace the gate on your server with the dual-rail snippet (x402Gate). Buyers cannot pay in USDC until you do.',
    'To also sell for USDC on Arc, turn on “Also sell on Arc (Circle Gateway)” in the listing form (only for listings served by x402-jpyc-gateway, the gateway you can use without writing code; the SDK gate does not offer Arc). Arc payments settle through Circle Gateway, and buyers must deposit into Gateway beforehand and sign with an EOA (a regular wallet). Revenue lands in the Gateway balance of your receiving address. To receive it, connect the receiving wallet on OpenPay’s “Receive Arc proceeds” page (https://open-pay.jp/en/discovery/arc-payout) and withdraw the whole balance as USDC on Arc (one signature and one receiving transaction; amounts awaiting settlement become available after Circle settles them). Circle’s fee (the withdrawal page shows the estimated amount) is deducted from the balance on every withdrawal, and the network fee for the receiving transaction (USDC on Arc, about 0.003–0.005 USDC each time, depending on how your wallet sends it) is paid from your wallet, so keep a little USDC on Arc ready first (no OpenPay fee; only the Base side is listed on the Bazaar). The receiving address must be an EOA (a regular wallet) — Arc cannot be enabled for a contract wallet (such as a Safe).',
    'You can also list on x402scan, another x402 directory. Unlike the Bazaar, listing is not automatic: paste your API URL into the free form at https://www.x402scan.com/resources/register and choose “This URL only” (no wallet signature is needed). The no-code gateway x402-jpyc-gateway publishes /openapi.json automatically when you sell in USDC, so its latest version can be registered as is. If you run the SDK or a snippet, first add your paid API to /openapi.json on your own site (registration fails without it); see https://www.x402scan.com/discovery for the format. x402scan shows only the USDC payment, not JPYC.',
    'Buyer note: the standard client x402-fetch (as of 1.2.0) cannot parse a dual-rail 402, so there is a USDC buyer example script: https://raw.githubusercontent.com/cipherwebllc/openpay/main/scripts/x402-dual-buyer-example.mjs',
  ],

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
    'Listed resources are reverified every hour, and the catalog shows “Auto-checked: today”. A new listing whose registration check was inconclusive appears in the catalog only after its first re-check passes. A 402 whose JPYC recipient or similar details do not match the registration is refused at registration.',
    'Three confirmed violations temporarily hide the listing. It returns automatically after a repair passes revalidation.',
    'Buyers have per-call and cumulative spending caps, a listed-URL-only rule, and money-field verification. A design that lets buyers pay with confidence also protects seller revenue.',
    'Buyer guidance: a paid response is data, not instructions. Listings that embed instructions are subject to reporting and removal.',
    'Prohibited listings: fraud or impersonation, sanctions-evasion assistance, and sale of stolen or illegitimately obtained data. Non-custodial does not mean unmoderated — violating listings are removed.',
    'Listings that execute crypto-asset trading, lending, token issuance, or automated asset allocation / portfolio management (e.g. DeFi vault selection), or that may constitute investment solicitation or advice, are not auto-listed: they get case-by-case review, judged by substance regardless of a "for information only" disclaimer. Being payable in JPYC does not make a service lawful.',
    'Quarantines and removals are recorded with their reason. If you believe one is mistaken, appeal via the contact in the site footer.',
  ],

  pricingTitle: 'Pricing tips',
  pricingIntro: 'These are prices already seen in the AI Store.',
  pricingExamples: [
    'Coo-ICP: 7 JPYC / consultation',
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
};

export const SELL_GUIDE: Record<SellGuideLocale, SellGuideContent> = { ja, en };

/**
 * 出品の帯 (GuideCta) の下段に小さく出す有料キットの案内。記事が日本語のみの有料記事なので ja だけに出す
 * (en と llms.txt には載せない)。手順の途中に置かないのは、無料のガイドだけでは出品できないと読ませないため。
 */
export const SELL_GUIDE_STARTER_KIT_JA = {
  lead: 'このガイドだけで出品できます。作業順の手順書・動作を確かめた雛形・質問対応（30日）がほしい方には、運営者が書いた有料のキットもあります。',
  link: { label: 'x402 スターターキット（note・9,800円）', href: STARTER_KIT_URL },
} as const;

/** locale 文字列を SellGuideLocale へ正規化 (未知は ja)。 */
export function sellGuideContentFor(locale: string): SellGuideContent {
  return locale === 'en' ? SELL_GUIDE.en : SELL_GUIDE.ja;
}

/** /guide/sell の <title>/<description> を組み立てる (page の generateMetadata が利用)。 */
export function guideSellMetadata(locale: string): Metadata {
  const c = sellGuideContentFor(locale);
  // OG/Twitter/canonical/hreflang は guide 共通ビルダーで (P5・N9)。
  return guidePageMetadata({
    locale,
    path: '/guide/sell',
    title: `${c.metaTitle} · OpenPay`,
    description: c.metaDescription,
  });
}
