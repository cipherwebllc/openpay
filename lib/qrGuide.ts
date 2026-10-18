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

  // JPYC 払いの割引 (2026-10-13)。JPYC 社の 10/09 の発表を受けて、値引き (plans/discount-common.md) の使い方と
  // 加盟店規約の注意をまとめる。/guide/shop からは #jpyc-discount で飛んでくる。
  readonly discountTitle: string;
  readonly discountLead: string;
  readonly discountPoints: readonly string[];
  readonly discountCaution: string;
  readonly discountSourceLabel: string;

  readonly currenciesTitle: string;


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
    '金額を入れて QR を見せるだけ。専用端末なしで、スマホから JPYC を受け取れます。導入費 0 円・契約も不要です。',
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
      body: '金額を入力するだけで決済QRが完成。画面提示のほか、印刷して置いておくこともできます。',
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
      body: 'お客様は支払い控えをブラウザに保存できます (レシートプリンターは不要)。インボイス登録番号を設定すると、控えに登録番号と税率ごとの金額・消費税も出ます。',
    },
    {
      title: '会計向け CSV',
      body: '売上履歴は会計ソフト向けの CSV (freee/弥生形式) に出力できます。確定申告の集計にも。',
    },
    {
      title: 'お店がガス代を肩代わりして送る',
      body: '決済モードで選ぶと、お店の端末のガス用ウォレット（POL・KAIA・AVAX）がガス代を払い、お客様は署名するだけ。OpenPay 利用料は 0 円（ガス代は実費・仕組み上 1 wei）。画面に表示した金額指定の QR だけで使えます（JPYC・Polygon・Kaia・Avalanche のみ。印刷・保存・URL のコピーをした QR と金額なしの QR は対象外）。',
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

  discountTitle: 'JPYC 払いで割引する',
  discountLead:
    '決済QR とレジには「値引き」があります。金額を入れたあと「＋ 値引きを追加」で割引率か金額を入れてから QR を出します（金額を指定した QR に付けられます）。',
  discountPoints: [
    'お客様の支払い画面と控えには、値引き前の金額・値引き・お支払いの額が出ます。取引履歴と会計用の CSV にも値引きが残ります。',
    '利用料と、控えに出る消費税は、値引き後の金額で計算されます。',
    '店頭で伝えるときは、「設定」の「ポスターの補足文」に「JPYC 払いで 5% 引き」のように書くと、印刷するポスターに出ます。ポスターの文言と QR の値引きは別々なので、同じ内容にそろえてください。',
    'モバイルオーダーは、「モバイル注文」タブの「値引き（任意）」で、公開したお店のページの全品に割引率か割引額を付けられます（AI エージェントが自分で払う注文には付きません）。',
  ],
  discountCaution:
    'クレジットカードなどの加盟店規約には、支払い方法によって価格を変えることを制限する条項がある場合があります。内容は会社ごとに違うので、契約している規約を確かめてください。JPYC 社は 2026 年 10 月 9 日の発表で、支払い方法ごとの価格や条件は加盟店の自由な経営判断に委ねられるべきという同社の考え方を示し、規約との関係で不安がある導入店向けの相談窓口を案内しています。これは JPYC 社の考え方で、公正取引委員会の見解ではありません。OpenPay は、個々の規約のもとで割引ができるかどうかは判断しません。',
  discountSourceLabel: 'JPYC 社の発表（2026 年 10 月 9 日・PR TIMES）',

  currenciesTitle: '対応通貨・チェーン',


  ctaTitle: 'まずは 1 枚、QR を作ってみる',
  ctaBody:
    'ウォレットを接続して金額を入力すれば、最初の決済QRは 30 秒で完成します。',
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
      body: 'Customers keep a payment record in their browser (no receipt printer needed). Set your invoice registration number and the record also shows it, with the amount and consumption tax for each tax rate.',
    },
    {
      title: 'Accounting CSV',
      body: 'Export sales history as CSV for accounting software (freee/Yayoi formats).',
    },
    {
      title: 'The shop pays the gas',
      body: 'Choose it as the payment mode and the gas wallet on the shop’s device (POL, KAIA or AVAX) pays the gas; customers only sign. The OpenPay usage fee is 0 (the actual gas; 1 wei by design). Works only for a fixed-amount QR shown on screen (JPYC on Polygon, Kaia and Avalanche only; not when printed, saved or copied, or without an amount).',
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

  discountTitle: 'Discounts for paying with JPYC',
  discountLead:
    'Payment QR and the register both have a “Discount” option. Enter the amount, then use “+ Add a discount” to set a percentage or an amount before showing the QR (it works on QRs with a set amount).',
  discountPoints: [
    'The customer’s payment screen and receipt show the price before the discount, the discount and the amount paid. Your history and the accounting CSV keep the discount too.',
    'The OpenPay fee and the consumption tax shown on receipts are calculated on the amount after the discount.',
    'To tell customers in store, write something like “5% off when you pay with JPYC” in “Poster note” under Settings; it appears on the printed poster. The poster text and the QR discount are separate, so keep them the same.',
    'For mobile ordering, “Discount (optional)” in the Mobile order tab applies a percentage or a fixed discount to every item on your published shop page (not applied to orders an AI agent pays for itself).',
  ],
  discountCaution:
    'Credit card and other merchant agreements may include terms that restrict charging different prices by payment method. These terms differ by company, so check the agreements you have signed. In a release on October 9, 2026, JPYC Inc. said it believes prices and conditions for each payment method should be left to each merchant’s own business judgment, and pointed merchants with concerns about their agreements to its merchant contact. This is JPYC Inc.’s view, not that of the Japan Fair Trade Commission. OpenPay does not judge whether a discount is allowed under any particular agreement.',
  discountSourceLabel: 'JPYC Inc. release (October 9, 2026, PR TIMES, Japanese)',

  currenciesTitle: 'Supported currencies & chains',


  ctaTitle: 'Make your first QR',
  ctaBody:
    'Connect a wallet, enter an amount, and your first payment QR is ready in 30 seconds.',
  ctaLabel: 'Create a payment QR',
};

export function qrGuideContentFor(locale: string): QrGuideContent {
  return locale === 'en' ? EN : JA;
}

/** /guide/qr の metadata。OG 画像は guide 共通の既定 (トップと同じ og-home.webp) を使う。 */
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
