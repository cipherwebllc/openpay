// /guide/shop 「レジ・モバイルオーダー」店舗運営者向け LP 兼ガイドの content SOT。
// (plans/site-ia-guides-ruling.md P3・N4: レジとモバイルオーダーは商品・メニューを
// 共有するため 1 LP に統合。/guide/pos = POS 併用運用・/guide/mobile-order = 顧客向けは
// 別ページとして維持し、本ページから相互リンクする)
// 長文を messages/*.json に置かない方針は lib/storeGuide.ts 等と同じ。
// ⚠️ 利用料の数値は本ファイルに書かない — page 側で掟 14 フェンス済みの
// Landing.supportFeeRegister*/supportFeeMobile* (messages) を描画する。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';

export type ShopGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;

  readonly heroTitle: string;
  readonly heroLead: string;
  readonly heroCtaRegister: string;
  readonly heroCtaMobile: string;
  readonly heroVisualAlt: string;

  readonly relationTitle: string;
  readonly relationBody: string;

  readonly featuresTitle: string;
  readonly features: readonly {
    readonly title: string;
    readonly body: string;
  }[];

  readonly flowTitle: string;
  readonly flowSteps: readonly string[];

  readonly scenesTitle: string;
  readonly sceneChips: readonly string[];

  readonly feeTitle: string;

  readonly startTitle: string;
  readonly startSteps: readonly string[];

  readonly guidesTitle: string;
  readonly guideLinkPos: string;
  readonly guideLinkCustomer: string;
  readonly guideLinkAgent: string;

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaLabel: string;
};

const JA: ShopGuideContent = {
  metaTitle: 'JPYCレジ・モバイルオーダー — 店舗運営をまとめて | OpenPay',
  metaDescription:
    '商品・メニューを一度登録すれば、店頭レジとモバイルオーダーで共通利用。注文内容と JPYC 決済をまとめて確認できます。専用端末不要・導入費 0 円・売上はウォレットへ直接着金。',
  backHome: '← OpenPay トップへ',

  heroTitle: '商品登録から注文受付まで、店舗運営をまとめて',
  heroLead:
    '登録した商品やメニューを、店頭レジとモバイルオーダーで共通利用。注文内容と JPYC 決済をまとめて確認できます。専用端末も月額費用も不要です。',
  heroCtaRegister: 'レジを始める',
  heroCtaMobile: 'モバイルオーダーを作る',
  heroVisualAlt:
    'お客様がスマホでメニューから注文して JPYC で支払い、店舗のタブレットに着金済みの新規注文が届くまでの流れの図解',

  relationTitle: 'レジとモバイルオーダーの関係',
  relationBody:
    '商品・メニューは一度登録すれば共通で使えます。店頭ではレジ (POS) として金額をその場で会計し、テーブルや店先に QR を置けば、お客様のスマホからのモバイル注文も同じメニューで受け付けられます。どちらの売上も、あなたのウォレットへ直接着金します。',

  featuresTitle: 'できること',
  features: [
    {
      title: '商品・メニュー管理',
      body: '商品名・価格・税率・メモを登録。複数商品の会計に対応し、レジとモバイルオーダーで共通利用できます。',
    },
    {
      title: '店頭レジ (POS)',
      body: '2 カラムの POS 画面で商品を選び、その場で QR 会計。現金と併用でき、専用端末は不要です。',
    },
    {
      title: 'モバイルオーダー',
      body: 'お客様は QR を読み取り、スマホでメニューを選んでそのまま JPYC で支払い。アプリのインストールは不要です。',
    },
    {
      title: '受注管理',
      body: '支払い済みの注文だけが店舗に届きます。受注一覧・調理中/お渡し済みの管理・お渡し準備完了の通知に対応。',
    },
    {
      title: '売上・注文履歴',
      body: '売上と注文の履歴をいつでも確認。会計ソフト向けの CSV (freee/弥生形式) も出力できます。',
    },
    {
      title: '電子レシート',
      body: 'お客様は支払い控えをブラウザに保存できます。紙のレシートやレシートプリンターは不要です。',
    },
  ],

  flowTitle: '注文から支払いまでの流れ',
  flowSteps: [
    'お客様が卓上やレジ横の QR を読み取り、メニューを開く',
    '商品を選んで、そのままウォレットで JPYC 決済 — 売上はあなたのウォレットへ直接着金',
    '支払い済みの注文だけが受注一覧に届く (取りこぼし・未払いの心配なし)',
    '調理・準備ができたら「お渡し準備完了」をお客様に通知',
  ],

  scenesTitle: '利用シーン',
  sceneChips: [
    '飲食店',
    '小売店',
    'キッチンカー',
    'イベント出店',
    'ポップアップストア',
  ],

  feeTitle: '利用料',

  startTitle: '導入手順 (3 ステップ)',
  startSteps: [
    'ウォレットを接続して、商品・メニューを登録する',
    '店頭ではレジタブで会計。モバイルオーダーは公開して QR を印刷・掲示する',
    '届いた注文と売上履歴を確認する — 必要なら会計 CSV を出力',
  ],

  guidesTitle: '詳しい操作ガイド',
  guideLinkPos: '今お使いの POS レジと併用する運用ガイド',
  guideLinkCustomer: 'お客様向け: モバイルオーダーのやり方',
  guideLinkAgent: 'お客様向け: AI に相談して注文する (訪日客向け)',

  ctaTitle: '今日から、専用端末なしで',
  ctaBody:
    '導入費 0 円・契約不要。商品を登録すれば、店頭レジもモバイルオーダーも今日から使えます。',
  ctaLabel: '商品・メニューを登録する',
};

const EN: ShopGuideContent = {
  metaTitle: 'JPYC POS & Mobile Ordering — run your shop in one place | OpenPay',
  metaDescription:
    'Register products and menus once and use them at both the counter POS and mobile ordering. See orders and JPYC payments together. No dedicated terminal, zero setup cost, sales settle straight to your wallet.',
  backHome: '← Back to OpenPay',

  heroTitle: 'From product setup to order intake, all in one place',
  heroLead:
    'Use the same products and menus for the counter POS and mobile ordering, and see orders and JPYC payments together. No dedicated terminal, no monthly fee.',
  heroCtaRegister: 'Start the POS',
  heroCtaMobile: 'Create mobile ordering',
  heroVisualAlt:
    'Diagram of a customer ordering from a phone menu, paying in JPYC, and the shop tablet receiving a paid order',

  relationTitle: 'How POS and mobile ordering relate',
  relationBody:
    'Register products and menus once and use them everywhere. At the counter, ring up amounts as a POS; put a QR on tables or at the storefront and the same menu takes mobile orders from customers’ phones. Sales from both settle directly to your wallet.',

  featuresTitle: 'What you can do',
  features: [
    {
      title: 'Product & menu management',
      body: 'Register names, prices, tax rates, and memos. Multi-item checkout, shared between POS and mobile ordering.',
    },
    {
      title: 'Counter POS',
      body: 'Pick items on a two-column POS screen and settle with a QR on the spot. Works alongside cash; no dedicated terminal.',
    },
    {
      title: 'Mobile ordering',
      body: 'Customers scan a QR, pick from the menu on their phone, and pay in JPYC right there. No app install.',
    },
    {
      title: 'Order management',
      body: 'Only paid orders reach the shop. Order list, preparing/served states, and “ready for pickup” notifications.',
    },
    {
      title: 'Sales & order history',
      body: 'Check sales and order history anytime, and export accounting CSV (freee/Yayoi formats).',
    },
    {
      title: 'Digital receipts',
      body: 'Customers keep a payment record in their browser. No paper receipts or receipt printer needed.',
    },
  ],

  flowTitle: 'From order to payment',
  flowSteps: [
    'A customer scans the QR on the table or counter and opens the menu',
    'They pick items and pay in JPYC from their wallet — sales settle straight to your wallet',
    'Only paid orders arrive in your order list (no unpaid orders to chase)',
    'When it’s ready, notify the customer with “ready for pickup”',
  ],

  scenesTitle: 'Where it fits',
  sceneChips: [
    'Restaurants',
    'Retail shops',
    'Food trucks',
    'Event booths',
    'Pop-up stores',
  ],

  feeTitle: 'Fees',

  startTitle: 'Get started in 3 steps',
  startSteps: [
    'Connect a wallet and register products and menus',
    'Use the POS tab at the counter; publish mobile ordering and print/post the QR',
    'Check incoming orders and sales history — export accounting CSV if needed',
  ],

  guidesTitle: 'Detailed guides',
  guideLinkPos: 'Running alongside your current POS register',
  guideLinkCustomer: 'For customers: how to order from your phone',
  guideLinkAgent: 'For customers: order by asking your AI (for visitors to Japan)',

  ctaTitle: 'Start today, no dedicated terminal',
  ctaBody:
    'Zero setup cost, no contract. Register products and both the POS and mobile ordering are ready today.',
  ctaLabel: 'Register products & menus',
};

export function shopGuideContentFor(locale: string): ShopGuideContent {
  return locale === 'en' ? EN : JA;
}

/** /guide/shop の metadata (title/description/OG/Twitter)。OG は user 提供の静的画像。 */
export function shopGuideMetadata(locale: string): Metadata {
  const c = shopGuideContentFor(locale);
  // OG/Twitter/canonical/hreflang は guide 共通ビルダーで (P5・N9)。
  return guidePageMetadata({
    locale,
    path: '/guide/shop',
    title: c.metaTitle,
    description: c.metaDescription,
    ogImage: {
      url: '/og-image-mobileorder.webp',
      width: 1280,
      height: 670,
      alt: c.heroVisualAlt,
    },
  });
}
