// /guide/qr 「決済QR」向け LP 兼ガイドの content SOT (plans/site-ia-guides-ruling.md P4・N3)。
// シンプルな JPYC 受け取りを始めたい人 (小規模店舗・個人事業主・イベント出店・フリマ・
// 対面販売) 向けの入口。/guide/pos (POS 併用)・/guide/shop (レジ・モバイルオーダー) とは
// 相互リンクで住み分ける。長文を messages/*.json に置かない方針は lib/shopGuide.ts と同じ。
// ⚠️ 利用料と対応通貨・チェーンの数値/一覧は本ファイルに書かない — page 側で掟 14
// フェンス済みの Landing.supportFeePay* / Landing.faqA2 (messages) を描画する。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';

export type QrGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;

  readonly heroTitle: string;
  readonly heroLead: string;
  readonly heroCtaCreate: string;
  readonly heroCtaScan: string;
  readonly heroVisualAlt: string;

  readonly forWhoTitle: string;
  readonly forWhoChips: readonly string[];

  readonly featuresTitle: string;
  readonly features: readonly {
    readonly title: string;
    readonly body: string;
  }[];

  readonly receiveFlowTitle: string;
  readonly receiveFlowSteps: readonly string[];
  readonly payFlowTitle: string;
  readonly payFlowSteps: readonly string[];

  readonly feeTitle: string;

  readonly currenciesTitle: string;

  readonly guidesTitle: string;
  readonly guideLinkPos: string;
  readonly guideLinkShop: string;

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaLabel: string;
};

const JA: QrGuideContent = {
  metaTitle: 'JPYC決済QR — スマホでかんたん受取 | OpenPay',
  metaDescription:
    '金額を入力して QR コードを提示するだけ。専用端末なしで、スマホから JPYC を受け取れます。導入費 0 円・契約不要・売上はウォレットへ直接着金。',
  backHome: '← OpenPay トップへ',

  heroTitle: '最短 30 秒で始める JPYC 決済QR',
  heroLead:
    '金額を入力して QR コードを提示するだけ。専用端末なしで、スマホから JPYC を受け取れます。導入費 0 円・契約も不要です。',
  heroCtaCreate: '決済QRを作る',
  heroCtaScan: '支払いを試す',
  heroVisualAlt:
    '店舗カウンターで顧客がスマホで QR 決済し、店舗端末に受取完了が表示されているイラスト',

  forWhoTitle: 'こんな人に向いています',
  forWhoChips: [
    '小規模店舗',
    '個人事業主',
    'イベント出店',
    'フリーマーケット',
    '対面販売',
    'まず試したい人',
  ],

  featuresTitle: 'できること',
  features: [
    {
      title: '金額入りの QR をその場で',
      body: '金額を入力するだけで決済 QR が完成。画面提示のほか、印刷して置いておくこともできます。',
    },
    {
      title: '専用端末は不要',
      body: 'お店側はスマホ (またはタブレット・PC) のブラウザだけ。アプリのインストールも不要です。',
    },
    {
      title: '売上は直接ウォレットへ',
      body: '支払い完了と同時に、あなたのウォレットへ直接着金。締め日も入金待ちもありません。',
    },
    {
      title: '売上履歴',
      body: '受け取りの履歴をいつでも確認できます。日付・通貨・チェーンでの絞り込みにも対応。',
    },
    {
      title: '電子レシート',
      body: 'お客様は支払い控えをブラウザに保存できます。レシートプリンターは不要です。',
    },
    {
      title: '会計向け CSV',
      body: '売上履歴は会計ソフト向けの CSV (freee/弥生形式) に出力できます。確定申告の集計にも。',
    },
  ],

  receiveFlowTitle: '受け取りの流れ (お店側)',
  receiveFlowSteps: [
    'ウォレットを接続して、金額を入力する',
    'できた QR をお客様に見せる (印刷して置いてもOK)',
    '支払い完了と同時にウォレットへ着金 — 履歴で確認できます',
  ],
  payFlowTitle: '支払いの流れ (お客様側)',
  payFlowSteps: [
    'スマホのカメラか OpenPay のスキャンで QR を読み取る',
    '金額を確認して、自分のウォレットで支払う',
    '完了画面と電子レシートで支払いを確認できる',
  ],

  feeTitle: '利用料',

  currenciesTitle: '対応通貨・チェーン',

  guidesTitle: '次のステップ',
  guideLinkPos: '今お使いの POS レジと併用する運用ガイド',
  guideLinkShop: '商品登録から注文受付まで — レジ・モバイルオーダー',

  ctaTitle: 'まずは 1 枚、QR を作ってみる',
  ctaBody:
    'ウォレットを接続して金額を入力すれば、最初の決済 QR は 30 秒で完成します。',
  ctaLabel: '決済QRを作る',
};

const EN: QrGuideContent = {
  metaTitle: 'JPYC Payment QR — accept payments from your phone | OpenPay',
  metaDescription:
    'Enter an amount and show a QR code — accept JPYC from your phone with no dedicated terminal. Zero setup cost, no contract, sales settle straight to your wallet.',
  backHome: '← Back to OpenPay',

  heroTitle: 'A JPYC payment QR in 30 seconds',
  heroLead:
    'Enter an amount and show the QR code. Accept JPYC from your phone with no dedicated terminal, zero setup cost, and no contract.',
  heroCtaCreate: 'Create a payment QR',
  heroCtaScan: 'Try paying',
  heroVisualAlt:
    'Illustration of a customer paying by scanning a QR code at a shop counter while the merchant tablet shows payment received',

  forWhoTitle: 'Who this is for',
  forWhoChips: [
    'Small shops',
    'Sole proprietors',
    'Event booths',
    'Flea markets',
    'In-person sales',
    'First-timers',
  ],

  featuresTitle: 'What you can do',
  features: [
    {
      title: 'A priced QR on the spot',
      body: 'Type an amount and the payment QR is ready. Show it on screen, or print it and leave it on the counter.',
    },
    {
      title: 'No dedicated terminal',
      body: 'All the shop needs is a browser on a phone, tablet, or PC. No app install.',
    },
    {
      title: 'Sales settle straight to your wallet',
      body: 'The moment a payment completes, it lands in your wallet. No settlement days, no waiting.',
    },
    {
      title: 'Sales history',
      body: 'Check your receiving history anytime, with filters by date, currency, and chain.',
    },
    {
      title: 'Digital receipts',
      body: 'Customers keep a payment record in their browser. No receipt printer needed.',
    },
    {
      title: 'Accounting CSV',
      body: 'Export sales history as CSV for accounting software (freee/Yayoi formats).',
    },
  ],

  receiveFlowTitle: 'How receiving works (shop side)',
  receiveFlowSteps: [
    'Connect a wallet and enter the amount',
    'Show the QR to the customer (printing it works too)',
    'Funds land in your wallet the moment payment completes — check it in history',
  ],
  payFlowTitle: 'How paying works (customer side)',
  payFlowSteps: [
    'Scan the QR with the phone camera or OpenPay’s scanner',
    'Check the amount and pay from your own wallet',
    'Confirm on the completion screen and keep a digital receipt',
  ],

  feeTitle: 'Fees',

  currenciesTitle: 'Supported currencies & chains',

  guidesTitle: 'Next steps',
  guideLinkPos: 'Running alongside your current POS register',
  guideLinkShop: 'From product setup to order intake — POS & mobile ordering',

  ctaTitle: 'Make your first QR',
  ctaBody:
    'Connect a wallet, enter an amount, and your first payment QR is ready in 30 seconds.',
  ctaLabel: 'Create a payment QR',
};

export function qrGuideContentFor(locale: string): QrGuideContent {
  return locale === 'en' ? EN : JA;
}

/** /guide/qr の metadata。OG 画像は現行トップの og-image.png を流用 (裁定 N8)。 */
export function qrGuideMetadata(locale: string): Metadata {
  const c = qrGuideContentFor(locale);
  // OG/Twitter/canonical/hreflang は guide 共通ビルダーで (P5・N9)。
  return guidePageMetadata({
    locale,
    path: '/guide/qr',
    title: c.metaTitle,
    description: c.metaDescription,
  });
}
