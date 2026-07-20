// /guide/mobile-order 「モバイルオーダーのやり方」(お客様向け) の content SOT。
// 長文を messages/*.json に置かない方針は lib/agentGuide.ts / lib/posGuide.ts と同じ。
// 画像は public/guide/mobile-order/ の実機スクリーンショット (サンプル店舗と同一メニューの
// 実描画・390px モバイル幅)。文言変更時はスクショとの整合も確認する。

export type MobileOrderGuideStep = {
  readonly n: number;
  readonly title: string;
  readonly body: string;
  readonly image: {
    readonly file: string; // public/guide/mobile-order/ 配下のファイル名
    readonly alt: string;
    readonly width: number;
    readonly height: number;
  };
};

export type MobileOrderGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly backHome: string;

  readonly title: string;
  readonly subtitle: string;
  readonly lead: string;

  readonly needTitle: string;
  readonly need: readonly string[];

  readonly stepsTitle: string;
  readonly steps: readonly MobileOrderGuideStep[];

  readonly faqTitle: string;
  readonly faq: readonly { readonly q: string; readonly a: string }[];

  readonly tryTitle: string;
  readonly tryBody: string;
  readonly tryCta: string;
  readonly tryUrl: string;

  readonly relatedTitle: string;
  readonly relatedAgentGuide: string;
};

const STEP_W = 390;
const STEP_H = 744;

const JA: MobileOrderGuideContent = {
  metaTitle: 'モバイルオーダーのやり方 — QR を読んでスマホで注文・JPYC で支払い',
  metaDescription:
    'OpenPay モバイルオーダーの使い方を 5 ステップで説明。アプリのインストール不要・お店の QR を読み取るだけ。支払いは自分のウォレットから JPYC、ガス代 (ネットワーク手数料) はかかりません。',
  backHome: '← OpenPay トップへ',

  title: 'モバイルオーダーのやり方',
  subtitle: 'アプリ不要。QR を読み取って、スマホで注文・お支払い。',
  lead: 'OpenPay モバイルオーダー対応のお店では、店頭やテーブルの QR コードを読み取るだけで、自分のスマホから注文して JPYC で支払えます。アプリのインストールも会員登録も要りません。',

  needTitle: '用意するもの',
  need: [
    'スマートフォン (カメラで QR を読めれば OK)',
    'JPYC が入った暗号資産ウォレット (MetaMask など)',
    'アプリのインストール・会員登録は不要です',
  ],

  stepsTitle: '注文から受け取りまで (5 ステップ)',
  steps: [
    {
      n: 1,
      title: 'お店の QR コードを読み取る',
      body: '店頭やテーブルの QR をスマホのカメラで読み取ると、お店の注文ページが開きます。',
      image: {
        file: 'step1.png',
        alt: 'お店の注文ページが開いた画面 (店名とメニュー)',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 2,
      title: 'メニューから選ぶ',
      body: '写真を見て「選ぶ」や「＋」をタップ。サイズなどのオプションもここで選べます。',
      image: {
        file: 'step2.png',
        alt: '商品のオプション (サイズ M / L) を選ぶ画面',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 3,
      title: '内容を確認して「支払いへ進む」',
      body: '画面下に注文がまとまります。店内で食べるときはテーブル番号を入力してください。',
      image: {
        file: 'step3.png',
        alt: 'テーブル番号を入れて支払いへ進むカート画面',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 4,
      title: 'ウォレットで支払う',
      body: '金額を確認して「ウォレットを接続」。署名は 1 回だけで、動くのは表示された金額だけです。ガス代 (ネットワーク手数料) はかかりません。',
      image: {
        file: 'step4.png',
        alt: '注文内容と支払い額を確認してウォレットを接続する画面',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 5,
      title: '受付番号で受け取る',
      body: '支払い後の画面に受付番号が表示されます。準備ができると「お渡しの準備ができました」に変わるので、番号を伝えて受け取ってください。',
      image: {
        file: 'step5.png',
        alt: '受付番号が表示された注文状況の画面',
        width: STEP_W,
        height: 420,
      },
    },
  ],

  faqTitle: 'よくある質問',
  faq: [
    {
      q: '現金やクレジットカードでも払える？',
      a: 'この注文ページは JPYC (日本円ステーブルコイン) 専用です。ほかの支払い方法はお店に直接ご確認ください。',
    },
    {
      q: 'アプリのインストールは必要？',
      a: '不要です。ブラウザだけで注文から支払いまで完結します。',
    },
    {
      q: '手数料やガス代はかかる？',
      a: 'かかりません。表示された金額だけを支払います。',
    },
    {
      q: '注文を間違えた・キャンセルしたい',
      a: 'ブロックチェーンの送金は原則取り消せません。支払い前に内容をよく確認し、困ったときはお店のスタッフに相談してください。',
    },
  ],

  tryTitle: 'サンプル店舗で試してみる',
  tryBody: '実際の画面の流れをサンプル店舗で体験できます。サンプルなので、実際の支払いはしないでください。',
  tryCta: 'サンプル店舗を開く',
  tryUrl: 'https://open-pay.jp/@openpay_test',

  relatedTitle: '関連ガイド',
  relatedAgentGuide: 'AI で注文するガイド (訪日・海外のお客様向け)',
};

const EN: MobileOrderGuideContent = {
  metaTitle: 'How to use mobile order — scan a QR, order on your phone, pay in JPYC',
  metaDescription:
    'How OpenPay mobile order works in 5 steps. No app install — just scan the QR at the shop. Pay JPYC from your own wallet with no gas fees.',
  backHome: '← Back to OpenPay',

  title: 'How to use mobile order',
  subtitle: 'No app needed. Scan the QR, order and pay on your phone.',
  lead: 'At shops using OpenPay mobile order, just scan the QR code at the counter or on your table. Order from your own phone and pay in JPYC — no app install, no sign-up.',

  needTitle: 'What you need',
  need: [
    'A smartphone (any camera that can scan a QR)',
    'A crypto wallet with JPYC (e.g. MetaMask)',
    'No app install or sign-up required',
  ],

  stepsTitle: 'From order to pickup (5 steps)',
  steps: [
    {
      n: 1,
      title: 'Scan the shop QR code',
      body: 'Scan the QR at the counter or table with your camera. The shop menu page opens.',
      image: {
        file: 'step1.png',
        alt: 'The shop order page with its menu',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 2,
      title: 'Pick from the menu',
      body: 'Tap "choose" or "+" on an item. Options like size are selected here too.',
      image: {
        file: 'step2.png',
        alt: 'Choosing item options (size M / L)',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 3,
      title: 'Review and continue to payment',
      body: 'Your order is summarized at the bottom. If you are dining in, enter your table number.',
      image: {
        file: 'step3.png',
        alt: 'Cart with table number and pay button',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 4,
      title: 'Pay with your wallet',
      body: 'Check the amount and connect your wallet. One signature, and only the displayed amount moves. No gas (network) fees.',
      image: {
        file: 'step4.png',
        alt: 'Checkout page with order summary and wallet connect',
        width: STEP_W,
        height: STEP_H,
      },
    },
    {
      n: 5,
      title: 'Pick up with your order number',
      body: 'After paying, your order number is shown. When it is ready, the screen switches to "ready for pickup" — show the number to pick up.',
      image: {
        file: 'step5.png',
        alt: 'Order status screen with an order number',
        width: STEP_W,
        height: 420,
      },
    },
  ],

  faqTitle: 'FAQ',
  faq: [
    {
      q: 'Can I pay with cash or a credit card?',
      a: 'This order page accepts JPYC (a Japanese yen stablecoin) only. Ask the shop directly about other payment methods.',
    },
    {
      q: 'Do I need to install an app?',
      a: 'No. Everything from ordering to payment works in your browser.',
    },
    {
      q: 'Are there fees or gas costs?',
      a: 'No. You pay exactly the amount displayed.',
    },
    {
      q: 'I made a mistake / want to cancel',
      a: 'Blockchain transfers generally cannot be reversed. Check your order before paying, and talk to the shop staff if something goes wrong.',
    },
  ],

  tryTitle: 'Try it on the sample shop',
  tryBody: 'You can walk through the real screens on our sample shop. It is a sample — please do not actually pay.',
  tryCta: 'Open the sample shop',
  tryUrl: 'https://open-pay.jp/@openpay_test',

  relatedTitle: 'Related guides',
  relatedAgentGuide: 'How to order with AI (for visitors to Japan)',
};

export function mobileOrderGuideContentFor(locale: string): MobileOrderGuideContent {
  return locale === 'en' ? EN : JA;
}

export function mobileOrderGuideMetadata(locale: string): {
  title: string;
  description: string;
} {
  const c = mobileOrderGuideContentFor(locale);
  return { title: `${c.metaTitle} · OpenPay`, description: c.metaDescription };
}
