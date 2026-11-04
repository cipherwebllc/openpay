// /guide/order-link「注文リンク」お店向けガイドの content SOT (ja/en 同梱)。
// /create の「注文リンク」タブ (components/OrderLinkBuilder.tsx・#963/#964) の使い方。SNS の DM・メール・自分の注文フォームで
// 受けた通販の注文ごとに、/checkout の支払いリンクを作って送る。住所は預からない (2026-11-02 user 裁定)。
// 「何度でも使える」リンク: 番号なしで SNS 等に置き、お客様は払った後に「注文を送る」でお名前とお届け先を自分の LINE や
// メールで送る。払ったウォレットの確認の署名で、文を送った人が払った人かをお店が確かめる (plans/order-link-reusable.md)。
// 画面の語に合わせる (「ガス代不要」「通常決済」「Tx Hash」「届いてから発送」= messages の OrderLinkBuilder)。
// 「」で引いたボタンの名前は tests/lib/orderLinkGuide.test.ts が messages と照合する。
// ⚠️ 利用料の率と最低額はここに書かない — {recoverPercent} と {recoverFloor} を page が DISCLOSED_* 由来の
// LANDING_PAYMENT_FEE_VALUES で埋める (掟 14)。1 回の上限の額も書かない (画面が出す)。
// 長文を messages/*.json に置かない方針は lib/qrGuide.ts と同じ。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';

export type OrderLinkGuideStep = { readonly title: string; readonly body: string };

export type OrderLinkGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;

  readonly subtitle: string;
  readonly lead: string;
  readonly ctaCreate: string;

  readonly forWhoTitle: string;
  readonly forWhoChips: readonly string[];

  readonly featuresTitle: string;
  readonly features: readonly { readonly title: string; readonly body: string }[];

  /** 手順は太字の題 + 1〜2 文 (題だけを拾い読みしても流れが分かる)。 */
  readonly stepsTitle: string;
  readonly steps: readonly OrderLinkGuideStep[];
  /**
   * 手順の横の図: 作る画面の「お客様の画面」(本番の画面を撮ったもの・public/guide/order-link/<file>)。
   * 「合計」の行で切る (下の「お店だけに表示」はお客様に出ないので写さない・利用料で額が変わる「届いてから発送」も写さない
   * = 料率が変わっても図が古くならない・掟 14)。
   */
  readonly previewShot: {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly alt: string;
    readonly caption: string;
  };
  /** 「設定」の項目の一覧 (手順の下の「くわしく」にたたむ)。 */
  readonly settingsLabel: string;
  readonly settings: readonly { readonly label: string; readonly body: string }[];
  readonly payStepsTitle: string;
  readonly paySteps: readonly OrderLinkGuideStep[];
  /** お客様の手順の下の 1 行 (ウォレットのガイドへのリンクの前置き)。 */
  readonly payNoWallet: string;

  readonly feeTitle: string;
  /** ガス代不要の利用料。{recoverPercent}・{recoverFloor} を page が埋める。 */
  readonly feeGasless: { readonly focal: string; readonly title: string; readonly body: string };
  readonly feeStandard: { readonly focal: string; readonly title: string; readonly body: string };
  readonly feeLimit: string;

  /** 発送の前の確認: 頭の 1 文 (画面のどこで確かめるか) + 必ず見る 3 つ (✓) + 残りの注意 (•・たたまない)。 */
  readonly checksTitle: string;
  readonly checksLead: string;
  readonly checks: readonly { readonly title: string; readonly body: string }[];
  readonly checksNotes: readonly string[];
  /** お店の責任 (画面の OrderLinkBuilder.sellerDuty と同じ文)。 */
  readonly sellerDuty: string;

  readonly faqTitle: string;
  readonly faq: readonly { readonly q: string; readonly a: string }[];

  readonly ctaTitle: string;
  readonly ctaBody: string;
  readonly ctaLabel: string;
};

const JA: OrderLinkGuideContent = {
  metaTitle: '注文リンク — 通販の注文ごとに JPYC の支払いリンクを送る | OpenPay',
  metaDescription:
    '通販の注文ごとに、商品と金額の入った JPYC の支払いリンクを作って、DM やメールで送れます。住所は預からず、売上はウォレットへ直接届きます。作り方と、発送の前に確かめること。',

  subtitle: 'DM で送る・SNS に置く、JPYC の支払いリンク',
  lead: '商品と合計の入った支払いリンクを作って、お客様に送るか SNS に置きます。お客様は自分のウォレットから JPYC で払います。',
  ctaCreate: '注文リンクを作る',

  forWhoTitle: 'こんなお店に向いています',
  forWhoChips: ['LINE 公式アカウントで注文を受けるお店', '個人の通販', 'ハンドメイド作家', 'SNS で注文を受けるお店', 'イベントの予約販売'],

  featuresTitle: 'できること',
  features: [
    {
      title: '「この注文だけ」のリンク',
      body: 'DM やメールで受けた注文ごとに送ります。注文番号 (A‑001〜) が自動で付きます。',
    },
    {
      title: '「何度でも使える」リンク',
      body: '番号なしで、お店の公式の SNS やサイトに置けます。お客様は払った後、お名前とお届け先をお店に送ります。',
    },
    {
      title: '住所を預からない',
      body: '氏名や住所は OpenPay に送られません。リンクを作るだけでは、注文の内容も送られません。',
    },
    {
      title: '売上はウォレットへ直接',
      body: 'お客様の支払いは受取ウォレットへ直接届きます。OpenPay は売上を預かりません。',
    },
  ],

  stepsTitle: '使い方 (お店)',
  steps: [
    {
      title: '設定する',
      body: '「設定」で店名・受取ウォレット・受取チェーンを決めます。受取ウォレットは、ウォレットを接続すると自動で入ります。',
    },
    {
      title: '商品を入れる',
      body: '「この注文だけ」か「何度でも使える」を選び、商品名・数量・単価と送料を入れます。氏名や住所は入れないでください (URL に入ります)。',
    },
    {
      title: 'リンクを送る',
      body: '「お客様の画面」で合計を確かめ、「リンクをコピー」か「送る」で LINE や DM、メールに貼ります。作る画面に出る「ウォレットに … JPYC 届いてから発送」の額は、注文と一緒に控えます (「次の注文へ」で消えます)。リンクに期限はないので、支払い期限は文に書き添えます。',
    },
    {
      title: '確かめてから発送',
      body: 'お客様から届いた文を「入金を確かめる」に貼り、下の 3 つを確かめてから発送します。',
    },
  ],
  previewShot: {
    file: 'preview-ja.webp',
    width: 756,
    height: 514,
    alt: '「お客様の画面」の例。OpenPay 工房の注文 (陶器のマグカップ、木のコースター 2 つ、送料) と合計 4,100 JPYC',
    caption: '手順 3 の「お客様の画面」(例)',
  },
  settingsLabel: '「設定」の項目',
  settings: [
    { label: '店名', body: 'お客様の支払い画面と控えに出ます。' },
    { label: '受取ウォレット', body: '売上が届くウォレット。通販専用にすると、入金を見分けやすくなります。' },
    {
      label: '受取チェーン',
      body: 'お客様の JPYC があるチェーン (迷ったら Polygon)。2 つ以上選ぶと、お客様が払うときに選べます。Safe などコントラクトのウォレットは 1 つにしてください。',
    },
    { label: '支払い方法', body: 'ガス代不要 (お客様は JPYC だけで払える) か、通常決済 (利用料なし)。' },
    {
      label: '注文の送り先',
      body: 'LINE 公式アカウントかメール。LINE にすると、払った後の注文の文が入った状態でトークが開き、お客様が送るとお店に届きます。',
    },
    { label: '消費税', body: '税率と、インボイス登録番号 (任意)。お客様の控えに出ます。' },
  ],
  payStepsTitle: '支払いの流れ (お客様)',
  paySteps: [
    {
      title: 'リンクを開く',
      body: '注文の内容と合計を確かめます。チェーンを選ぶ画面が出たら、JPYC があるチェーンを選びます。',
    },
    { title: 'JPYC で払う', body: '自分のウォレットをつないで払います。OpenPay のアプリは要りません。' },
    {
      title: 'お店に知らせる',
      body: '完了画面の「お店に知らせる」で確認の署名をして送ります (お金は動きません)。「何度でも使える」リンクでは「注文を送る」で、お名前とお届け先を書き足して送ります。',
    },
  ],
  payNoWallet: 'ウォレットを持っていないお客様には',

  feeTitle: '支払い方法と利用料',
  feeGasless: {
    focal: '{recoverPercent}%',
    title: 'ガス代不要',
    body: 'お客様は JPYC だけで払えます。利用料は決済額の {recoverPercent}%・最低 {recoverFloor} JPYC で、お店の受取から引かれます。お客様が払う額は合計のままです。',
  },
  feeStandard: {
    focal: 'なし',
    title: '通常決済',
    body: 'OpenPay の利用料はかかりません。',
  },
  feeLimit: 'ガス代不要には 1 回の額の上限があります。超えたときは、作る画面の「この注文だけ通常決済にする」で作れます。',

  checksTitle: '発送の前に確かめること',
  checksLead: '「注文リンク」タブの「入金を確かめる」に、お客様から届いた文を貼って「確かめる」を押します。3 つがそろったら発送します。',
  checks: [
    {
      title: '届いた額が合っている',
      body: '「受取ウォレットに … JPYC 届いています」の額を、送るときに控えた「ウォレットに … JPYC 届いてから発送」の額と比べます。リンクの金額は、お客様が書き換えられます。',
    },
    {
      title: '確認の署名がある',
      body: 'お客様が、払ったウォレットで付ける署名です (お金は動きません)。Tx Hash (支払いごとの番号) は誰でも見られるので、Tx Hash だけでは払った人の証明になりません。',
    },
    {
      title: '同じ Tx Hash の注文がほかにない',
      body: 'お店の注文の記録と照らし合わせます (同じ端末で前に確かめた Tx Hash なら、画面も知らせます)。2 件届いたら、両方の発送を止めて確かめます。',
    },
  ],
  checksNotes: [
    '署名がない・合わないときは、発送を止めてお客様に確かめてください。',
    'リンクからの入金は OpenPay の履歴に出ません。',
    '受付番号はチェーンに残りません。同じ額の注文は、額と時刻と Tx Hash で見分けます。',
    '注文番号は端末ごとに数えます。別の端末で作ると、番号は続きになりません。',
  ],
  sellerDuty:
    '住所などのお客様の情報、特定商取引法の表示、発送と返金はお店の責任です。OpenPay は売買の当事者ではありません。',

  faqTitle: 'よくある質問',
  faq: [
    {
      q: '確認の署名で何が分かりますか？',
      a: '署名したのが、その支払いをしたウォレットの持ち主かが分かります (他人の Tx Hash を使った注文を見分けられます)。文は転送できるので、送ってきた人やお届け先が正しいかまでは分かりません。',
    },
    {
      q: '値引きはできますか？',
      a: 'できます。「値引きを追加」で金額か割引率を入れると、お客様の画面に小計・値引き・お支払いの額が出ます。割引率は送料にはかけません。',
    },
    {
      q: '消費税やインボイスに対応できますか？',
      a: 'できます。「設定」の消費税で税率を選ぶと、控えに税率と消費税が出ます。インボイス登録番号と店名も入れると、登録番号と税率ごとの金額・消費税も出ます (課税の商品か送料がある注文)。OpenPay の履歴には残らないので、記帳はお店の記録で行ってください。',
    },
    {
      q: '送ったリンクの金額や内容を変えたいときは？',
      a: '新しいリンクを作って送り直し、どちらのリンクで払うかをお客様に伝えてください。送ったリンクは取り消せません。',
    },
    {
      q: '返金はどうしますか？',
      a: 'お店が自分のウォレットから、お客様のウォレットへ送ります。ブロックチェーン上の送金は取り消せず、OpenPay は売買の当事者ではないので、代わりに返金できません。',
    },
    {
      q: '住所はどう受け取りますか？',
      a: '今お使いの注文フォームやメッセージか、「何度でも使える」リンクでお客様が送る注文で受け取ります。郵便局アプリで送り状を作るなら、日本郵便のデジタルアドレス (英数字 7 文字) でも受け取れます。お名前は別に聞き、発送後はデジタルアドレスを残さないでください (引っ越し後の住所も引けるため)。',
    },
  ],

  ctaTitle: 'まずは 1 件、リンクを作ってみる',
  ctaBody: '商品と単価を入れればリンクができます。送る前に「開いて確かめる」で、お客様の画面を見られます。',
  ctaLabel: '注文リンクを作る',
};

const EN: OrderLinkGuideContent = {
  metaTitle: 'Order links — send a JPYC payment link for each online order | OpenPay',
  metaDescription:
    'Make a JPYC payment link with the items and total for each online order and send it by DM or email. No addresses are stored, and sales go straight to your wallet. How to make one, and what to check before you ship.',

  subtitle: 'JPYC payment links to send by DM or post on social media',
  lead: 'Make a payment link with the items and total, then send it to the customer or post it on social media. The customer pays in JPYC from their own wallet.',
  ctaCreate: 'Make an order link',

  forWhoTitle: 'Who this is for',
  forWhoChips: ['Shops taking orders on a LINE Official Account', 'Small online shops', 'Makers and crafters', 'Shops taking orders on social media', 'Event pre-orders'],

  featuresTitle: 'What you can do',
  features: [
    {
      title: '“One order” links',
      body: 'Send one for each order you take by DM or email. Order numbers (A‑001 and up) are added automatically.',
    },
    {
      title: '“Reusable” links',
      body: 'No order number, so you can post one on your official social media or site. After paying, customers send you their name and delivery address.',
    },
    {
      title: 'No addresses stored',
      body: 'Names and addresses are not sent to OpenPay. Making a link sends nothing about the order either.',
    },
    {
      title: 'Sales go straight to your wallet',
      body: 'Payments go directly to your receiving wallet. OpenPay does not hold your sales.',
    },
  ],

  stepsTitle: 'How to use it (shop)',
  steps: [
    {
      title: 'Set up',
      body: 'In “Settings”, set your shop name, receiving wallet and receiving chain. The receiving wallet fills in when you connect your wallet.',
    },
    {
      title: 'Add the items',
      body: 'Choose “One order” or “Reusable”, then enter the item names, quantities, unit prices and shipping. Do not enter names or addresses (they would end up in the URL).',
    },
    {
      title: 'Send the link',
      body: 'Check the total in “What the customer sees”, then paste it into LINE, a DM or an email with “Copy link” or “Send”. Note the “Ship after … JPYC reaches your wallet” amount shown on the screen with the order (“Next order” clears it). Links do not expire, so add your payment deadline to the message.',
    },
    {
      title: 'Check, then ship',
      body: 'Paste the message the customer sends into “Check a payment” and ship once the three checks below hold.',
    },
  ],
  previewShot: {
    file: 'preview-en.webp',
    width: 756,
    height: 514,
    alt: 'Example of “What the customer sees”: an order from OpenPay Studio (a ceramic mug, two wooden coasters and shipping) totaling 4,100 JPYC',
    caption: '“What the customer sees” in step 3 (example)',
  },
  settingsLabel: 'What’s in “Settings”',
  settings: [
    { label: 'Shop name', body: 'Shown on the customer’s payment screen and receipt.' },
    { label: 'Receiving wallet', body: 'Where your sales arrive. A wallet just for online sales makes payments easier to tell apart.' },
    {
      label: 'Receiving chain',
      body: 'A chain your customers hold JPYC on (Polygon if unsure). With two or more, customers choose one when paying. Pick only one for contract wallets such as Safe.',
    },
    { label: 'Payment method', body: 'No gas fee (customers pay with JPYC alone) or standard payment (no fee).' },
    {
      label: 'Where orders go',
      body: 'A LINE Official Account or email. With LINE, the chat opens with the order message filled in after payment, and it reaches you when the customer sends it.',
    },
    { label: 'Consumption tax', body: 'The tax rate and your invoice registration number (optional). Shown on the customer’s receipt.' },
  ],
  payStepsTitle: 'How paying works (customer)',
  paySteps: [
    {
      title: 'Open the link',
      body: 'They check the order and total. If asked to choose a chain, they pick one where they hold JPYC.',
    },
    { title: 'Pay in JPYC', body: 'They connect their own wallet and pay. No OpenPay app is needed.' },
    {
      title: 'Tell the shop',
      body: 'On the completion screen they tap “Tell the shop”, sign the confirmation and send it (no money moves). With a “Reusable” link, they use “Send your order” and add their name and delivery address before sending.',
    },
  ],
  payNoWallet: 'For customers without a wallet:',

  feeTitle: 'Payment methods and fees',
  feeGasless: {
    focal: '{recoverPercent}%',
    title: 'No gas fee',
    body: 'Customers pay with JPYC alone. The fee is {recoverPercent}% of the payment, at least {recoverFloor} JPYC, taken from what the shop receives. The customer pays the total as shown.',
  },
  feeStandard: {
    focal: 'None',
    title: 'Standard payment',
    body: 'No OpenPay fee.',
  },
  feeLimit: 'No-gas-fee links have a limit per payment. If an order goes over it, use “Use standard payment for this order” where you make the link.',

  checksTitle: 'Check before you ship',
  checksLead: 'In the “Order link” tab, paste the message the customer sent into “Check a payment” and press “Check”. Ship once all three hold.',
  checks: [
    {
      title: 'The amount matches',
      body: 'Compare “… JPYC reached your receiving wallet” with the “Ship after … JPYC reaches your wallet” amount you noted when sending. Customers can edit the amount in the link.',
    },
    {
      title: 'It carries the confirmation signature',
      body: 'A signature the customer makes with the wallet they paid from (no money moves). Anyone can look up a Tx Hash (the ID of each payment), so a Tx Hash alone does not prove who paid.',
    },
    {
      title: 'No other order has the same Tx Hash',
      body: 'Check it against your order records (the screen also tells you if you checked the same Tx Hash on this device before). If two arrive, hold both and check.',
    },
  ],
  checksNotes: [
    'If there is no signature or it does not match, hold the order and check with the customer.',
    'Payments from these links do not appear in your OpenPay history.',
    'Order numbers are not recorded on the chain. Tell orders with the same amount apart by amount, time and Tx Hash.',
    'Order numbers are counted per device. A link made on another device does not continue the numbering.',
  ],
  sellerDuty:
    'Customer details such as addresses, the disclosures required by Japan’s Act on Specified Commercial Transactions, shipping and refunds are the shop’s responsibility. OpenPay is not a party to the sale.',

  faqTitle: 'FAQ',
  faq: [
    {
      q: 'What does the confirmation signature tell me?',
      a: 'That it was signed by the owner of the wallet that made the payment (so it catches orders that use someone else’s Tx Hash). A message can be forwarded, so it does not tell you who sent it or that the delivery address is right.',
    },
    {
      q: 'Can I give a discount?',
      a: 'Yes. Use “Add discount” to enter an amount or a percentage, and the customer’s screen shows the subtotal, the discount and the amount to pay. A percentage does not apply to shipping.',
    },
    {
      q: 'Can I handle consumption tax and invoices?',
      a: 'Yes. Pick a tax rate under Consumption tax in “Settings”, and the receipt shows the tax rate and the consumption tax. Add your invoice registration number and shop name too, and it also shows the number with the amount and consumption tax per rate (for orders with a taxed item or shipping). None of this is kept in your OpenPay history, so keep your own records for bookkeeping.',
    },
    {
      q: 'What if I need to change the amount or items after sending?',
      a: 'Make a new link, send it, and tell the customer which link to pay. A sent link cannot be cancelled.',
    },
    {
      q: 'How do refunds work?',
      a: 'The shop sends it from its own wallet to the customer’s wallet. Blockchain transfers cannot be reversed, and OpenPay is not a party to the sale, so it cannot refund on your behalf.',
    },
    {
      q: 'How do I get the shipping address?',
      a: 'Through the order form or messages you already use, or from the order the customer sends from a “Reusable” link. If you make shipping labels in the Japan Post app, you can also accept a Japan Post digital address (a 7‑character code). Ask for the name separately, and delete the digital address after shipping (it keeps pointing to the customer even after they move).',
    },
  ],

  ctaTitle: 'Make your first link',
  ctaBody: 'Enter the items and prices and the link is ready. Before sending, “Open and check” shows you the customer’s screen.',
  ctaLabel: 'Make an order link',
};

export function orderLinkGuideContentFor(locale: string): OrderLinkGuideContent {
  return locale === 'en' ? EN : JA;
}

/** /guide/order-link の metadata (OG 画像は guide 共通の既定)。 */
export function orderLinkGuideMetadata(locale: string): Metadata {
  const c = orderLinkGuideContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/guide/order-link',
    title: c.metaTitle,
    description: c.metaDescription,
  });
}
