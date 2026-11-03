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

  readonly stepsTitle: string;
  readonly steps: readonly string[];
  readonly payStepsTitle: string;
  readonly paySteps: readonly string[];

  readonly feeTitle: string;
  /** ガス代不要の利用料。{recoverPercent}・{recoverFloor} を page が埋める。 */
  readonly feeGasless: { readonly focal: string; readonly title: string; readonly body: string };
  readonly feeStandard: { readonly focal: string; readonly title: string; readonly body: string };
  readonly feeLimit: string;

  readonly checksTitle: string;
  readonly checks: readonly string[];
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

  subtitle: 'DM やメールで受けた注文に、支払いリンクを送る',
  lead:
    '通販の注文ごとに、商品と金額の入った支払いリンクを作ってお客様に送ります。お客様は自分のウォレットから JPYC で払い、売上はお店のウォレットへ直接届きます。住所などのお客様の情報は OpenPay に送られません。',
  ctaCreate: '注文リンクを作る',

  forWhoTitle: 'こんなお店に向いています',
  forWhoChips: ['個人の通販', 'ハンドメイド作家', 'SNS で注文を受けるお店', 'イベントの予約販売'],

  featuresTitle: 'できること',
  features: [
    {
      title: '注文ごとの支払いリンク',
      body: '商品名・数量・単価と送料を入れると、合計の入った支払いリンクができます。注文番号は A-001 から自動で付き、「リンクをコピー」か「送る」で LINE や SNS の DM、メールに貼れます。',
    },
    {
      title: '何度でも使えるリンク',
      body: '「何度でも使える」にすると、番号なしのリンクを商品ごとに作って SNS やサイトに置けます。お客様は払った後、完了画面の「注文を送る」で、お名前とお届け先をお店の LINE やメールへ送ります。',
    },
    {
      title: '住所を預からない',
      body: 'リンクを作るだけでは、注文の内容は OpenPay に送られません。氏名や住所は、今お使いの注文フォームやメッセージか、お客様が自分の LINE やメールで送る注文で受け取ります。',
    },
    {
      title: '売上はウォレットへ直接',
      body: 'お客様の支払いは、設定した受取ウォレットへ直接届きます。OpenPay は売上を預かりません。',
    },
  ],

  stepsTitle: '使い方 (お店)',
  steps: [
    '「販売」の「注文リンク」タブを開き、「設定」で店名・受取ウォレット・受取チェーン・支払い方法・注文の送り先 (LINE 公式アカウントかメール) を決める (店名はお客様の支払い画面に出ます。チェーンはお客様の JPYC があるものを 1 つ以上。2 つ以上選ぶと、お客様が払うときに選べます。迷ったら Polygon)',
    '注文ごとに送るなら「この注文だけ」、SNS などに置いておくなら「何度でも使える」を選び、商品名・数量・単価を入れる。送料と説明は要るときだけ',
    '「お客様の画面」で明細と合計を確かめ、「リンクをコピー」か「送る」でお客様に送るか、SNS などに置く。「この注文だけ」の注文番号はこのときに決まります',
    'お客様から届いた文を「入金を確かめる」に貼り、受取ウォレットに届いた額と確認の署名を確かめてから発送する',
    '次の注文は「次の注文へ」から作る',
  ],
  payStepsTitle: '支払いの流れ (お客様)',
  paySteps: [
    'お店のリンクを開き、注文の内容と合計を確かめる (チェーンを選ぶ画面が出たら、お手持ちの JPYC があるチェーンを選ぶ)',
    '自分のウォレットをつないで、JPYC で払う',
    '完了画面の「注文を送る」(番号つきの注文では「お店に知らせる」) を押し、ウォレットで確認の署名をして (お金は動きません)、お店の LINE やメールへ送る。「何度でも使える」リンクでは、お名前とお届け先を書き足して送る',
  ],

  feeTitle: '支払い方法と利用料',
  feeGasless: {
    focal: '{recoverPercent}%',
    title: 'ガス代不要',
    body: 'お客様は JPYC だけで払えます (ガス代は要りません)。利用料は決済額の {recoverPercent}%・最低 {recoverFloor} JPYC で、お店の受取から引かれます。お客様が払う額は合計のままです。',
  },
  feeStandard: {
    focal: 'なし',
    title: '通常決済',
    body: 'OpenPay の利用料はかかりません。お客様が自分のウォレットでネットワークのガス代を払います。',
  },
  feeLimit:
    'ガス代不要で作れる 1 回の額には上限があります。超えたときは、画面の「この注文だけ通常決済にする」で作れます (次の注文はガス代不要に戻ります)。',

  checksTitle: '発送の前に確かめること',
  checks: [
    '画面に出る「ウォレットに … JPYC 届いてから発送」の額が受取ウォレットに届いたのを確かめてから、発送してください。ガス代不要の注文は、利用料を引いた額が届きます。',
    'リンクの金額は、お客様が書き換えられます。届いた額が注文の額と合っているかを確かめてください。',
    'リンクからの入金は OpenPay の履歴に出ません。注文リンクのタブの「入金を確かめる」にお客様から届いた文を貼るか、受取ウォレットで確かめます。',
    'Tx Hash は誰でも Explorer で見られるので、Tx Hash だけでは払った人の証明になりません。届いた文を「入金を確かめる」に貼り、払ったウォレットの確認の署名があるものを発送してください。署名がない・合わないときは、発送を止めてお客様に確かめてください。',
    '同じ額の注文が重なったときは、お客様から届いた Tx Hash で見分けます。同じ Tx Hash の注文が 2 件届いたら、両方の発送を止めて確かめてください。',
    'リンクに期限はありません。支払い期限はお客様に伝えてください。',
    '氏名・住所はリンクに入れないでください (URL に入ります)。',
    '注文番号は端末ごとに数えます。別の端末で作ると、番号は続きになりません。「何度でも使える」リンクには番号がありません。',
  ],
  sellerDuty:
    '住所などのお客様の情報、特定商取引法の表示、発送と返金はお店の責任です。OpenPay は売買の当事者ではありません。',

  faqTitle: 'よくある質問',
  faq: [
    {
      q: '支払われたかどうかは、どこで分かりますか？',
      a: 'お客様から届いた文 (Tx Hash だけでも) を、注文リンクのタブの「入金を確かめる」に貼ると、受取ウォレットに届いた額と時刻、払ったウォレットの確認の署名があるかが分かります。受付番号はチェーンに残らないので、額と時刻で注文と照らし合わせてください。リンクからの入金は OpenPay の履歴には出ません。',
    },
    {
      q: '「何度でも使える」リンクでは、注文をどう受け取りますか？',
      a: 'お客様は払った後、完了画面の「注文を送る」から、商品・金額・Tx Hash・確認の署名の入った文を、設定した LINE 公式アカウントかメールへ送ります。お名前とお届け先は、お客様がその文に書き足します。OpenPay の画面にもサーバーにも入りません。送り先を設定していなければ、お客様が共有かコピーで送ります。LINE は公式アカウントだけで、友だちでないお客様には先に友だち追加が出ます。',
    },
    {
      q: '確認の署名とは何ですか？',
      a: 'お客様が、払ったウォレットで決まった文 (お店と Tx Hash) に付ける署名です。お金は動きません。Tx Hash は誰でも見られるので、他人の支払いの Tx Hash を貼った注文が届くことがあります。「入金を確かめる」は、署名したのがその支払いをしたウォレットの持ち主かを確かめます。署名が示すのはそれだけで、文は転送できるので、送ってきた人やお届け先が正しいかは示しません。書き換えたリンクを広められないよう、お店のリンクは公式の SNS やサイトに置いてください。',
    },
    {
      q: '受取チェーンを複数にできますか？',
      a: 'できます。設定の受取チェーンで 2 つ以上選ぶと、お客様は払う前にチェーンを選び、どのチェーンで払ってもお店の同じウォレットに届きます。「入金を確かめる」は選んだチェーンを全部探し、どのチェーンで払われたかを出します。Safe などのコントラクトのウォレットはチェーンごとに持ち主が違うことがあるので、受取チェーンは 1 つにしてください。2 つ以上を選ぶと画面がチェーン上で確かめて止めますが、まだ一度も使っていないウォレットは見分けられません。',
    },
    {
      q: '値引きはできますか？',
      a: 'できます。「値引きを追加」で金額か割引率を入れると、お客様の画面に小計・値引き・お支払いの額が出ます。割引率は商品の合計にかけ、送料にはかけません。「ウォレットに … JPYC 届いてから発送」の額も値引きの後の額で出ます。値引きは作っているリンクだけに入り、「次の注文へ」で外れます。',
    },
    {
      q: '消費税やインボイスに対応できますか？',
      a: 'できます。「設定」の消費税で税率を選ぶと、商品ごとに税率を変えられ、お客様の控えに税率と消費税が出ます。送料は標準税率です。インボイス登録番号と店名も入れると、課税の商品か送料がある注文では、控えに登録番号と、税率ごとの金額・消費税が出ます (法人や個人事業主のお客様向け)。値引きは、控えで税率ごとの金額の比で分けます (レジと同じ)。税率と登録番号は控えに出るだけで、お店の OpenPay の履歴には残りません。記帳はお店の記録で行ってください。',
    },
    {
      q: '送ったリンクの金額や内容を変えたいときは？',
      a: '新しいリンクを作って送り直してください。送ったリンクは取り消せず、期限もないので、どちらのリンクで払うかをお客様に伝えてください。',
    },
    {
      q: '返金はどうしますか？',
      a: 'ブロックチェーン上の送金は取り消せないので、返金はお店が自分のウォレットからお客様のウォレットへ送ります。OpenPay は売買の当事者ではなく、代わりに返金することはできません。',
    },
    {
      q: '住所はどう受け取りますか？',
      a: 'お名前とお届け先は、今お使いの注文フォームやメッセージか、「何度でも使える」リンクでお客様が送る注文で受け取ります (OpenPay には送られません)。郵便局アプリで送り状を作るなら、住所の代わりに日本郵便のデジタルアドレス (英数字 7 文字) を受け付けると、お客様の入力が短くなります。デジタルアドレスに名前は入らないので、お名前は別に聞いてください。発送したあとは、デジタルアドレスを残さないでください (お客様が引っ越した後の住所も引けるためです)。',
    },
    {
      q: 'お客様にアプリは要りますか？',
      a: 'OpenPay のアプリは要りません。お客様はリンクをブラウザで開き、自分のウォレットで払います。ウォレットを持っていないお客様には、「ウォレットを選ぶ」のガイドを案内してください。',
    },
  ],

  ctaTitle: 'まずは 1 件、リンクを作ってみる',
  ctaBody:
    '受取ウォレットを決めて、商品と単価を入れればリンクができます。初めは「開いて確かめる」でお客様の画面を見てから送ると安心です。',
  ctaLabel: '注文リンクを作る',
};

const EN: OrderLinkGuideContent = {
  metaTitle: 'Order links — send a JPYC payment link for each online order | OpenPay',
  metaDescription:
    'Make a JPYC payment link with the items and total for each online order and send it by DM or email. No addresses are stored, and sales go straight to your wallet. How to make one, and what to check before you ship.',

  subtitle: 'Send a payment link for orders you take by DM or email',
  lead:
    'For each online order, make a payment link with the items and amount and send it to the customer. They pay in JPYC from their own wallet, and the money goes straight to your wallet. Names, addresses and other customer details are not sent to OpenPay.',
  ctaCreate: 'Make an order link',

  forWhoTitle: 'Who this is for',
  forWhoChips: ['Small online shops', 'Makers and crafters', 'Shops taking orders on social media', 'Event pre-orders'],

  featuresTitle: 'What you can do',
  features: [
    {
      title: 'A payment link for each order',
      body: 'Enter the item names, quantities, unit prices and shipping, and you get a payment link with the total. Order numbers start at A-001 and count up automatically, and “Copy link” or “Send” lets you paste it into LINE, a social media DM or an email.',
    },
    {
      title: 'Reusable links',
      body: 'Choose “Reusable” to make a link without an order number for each item and post it on social media or your site. After paying, customers use “Send your order” on the completion screen to send their name and delivery address to your LINE or email.',
    },
    {
      title: 'No addresses stored',
      body: 'Making a link sends nothing about the order to OpenPay. Collect names and addresses with the order form or messages you already use, or from the order the customer sends from their own LINE or email.',
    },
    {
      title: 'Sales go straight to your wallet',
      body: 'Payments go directly to the receiving wallet you set. OpenPay does not hold your sales.',
    },
  ],

  stepsTitle: 'How to use it (shop)',
  steps: [
    'Open the “Order link” tab under “Sell”, and in “Settings” set your shop name, receiving wallet, receiving chain, payment method and where orders are sent (a LINE Official Account or email) (the shop name appears on the customer’s payment screen; pick one or more chains your customers hold JPYC on. With two or more, customers choose one when paying. Polygon if unsure)',
    'Choose “One order” to send a link per order or “Reusable” to post one on social media, then enter the item names, quantities and unit prices. Add shipping and a description only when needed',
    'Check the items and total in “What the customer sees”, then send it with “Copy link” or “Send”, or post it. For “One order” links, the order number is fixed at this point',
    'Paste the message the customer sent into “Check a payment” and ship only after the amount has reached your receiving wallet and the confirmation signature checks out',
    'Start the next order with “Next order”',
  ],
  payStepsTitle: 'How paying works (customer)',
  paySteps: [
    'Open the shop’s link and check the order and total (if asked to choose a chain, pick the one where they hold JPYC)',
    'Connect their own wallet and pay in JPYC',
    'Tap “Send your order” on the completion screen (“Tell the shop” for numbered orders), sign the confirmation in their wallet (no money moves) and send it to the shop’s LINE or email. For “Reusable” links, add their name and delivery address before sending',
  ],

  feeTitle: 'Payment methods and fees',
  feeGasless: {
    focal: '{recoverPercent}%',
    title: 'No gas fee',
    body: 'Customers pay with JPYC alone (no gas needed). The fee is {recoverPercent}% of the payment, at least {recoverFloor} JPYC, taken from what the shop receives. The customer pays the total as shown.',
  },
  feeStandard: {
    focal: 'None',
    title: 'Standard payment',
    body: 'No OpenPay fee. The customer pays the network gas from their own wallet.',
  },
  feeLimit:
    'There is a limit on how much a single no-gas-fee link can charge. If an order goes over it, use “Use standard payment for this order” on the screen (the next order goes back to no gas fee).',

  checksTitle: 'Check before you ship',
  checks: [
    'Ship only after the amount shown in “Ship after … JPYC reaches your wallet” has reached your receiving wallet. For no-gas-fee orders, the amount after the fee arrives.',
    'Customers can edit the amount in the link. Check that the amount you received matches the order.',
    'Payments from these links do not appear in your OpenPay history. Paste the message the customer sent into “Check a payment” in the Order link tab, or check your receiving wallet.',
    'Anyone can look up a Tx Hash on an explorer, so a Tx Hash alone does not prove who paid. Paste the message into “Check a payment” and ship the orders that carry the paying wallet’s confirmation signature. If there is no signature or it does not match, stop and check with the customer.',
    'If two orders have the same amount, tell them apart by the Tx Hash the customer sends you. If two orders arrive with the same Tx Hash, hold both and check.',
    'Links do not expire. Tell customers the payment deadline yourself.',
    'Do not put names or addresses in the link (they would end up in the URL).',
    'Order numbers are counted per device. A link made on another device does not continue the numbering. “Reusable” links have no order number.',
  ],
  sellerDuty:
    'Customer details such as addresses, the disclosures required by Japan’s Act on Specified Commercial Transactions, shipping and refunds are the shop’s responsibility. OpenPay is not a party to the sale.',

  faqTitle: 'FAQ',
  faq: [
    {
      q: 'How do I know the customer has paid?',
      a: 'Paste the message the customer sent (a Tx Hash alone also works) into “Check a payment” in the Order link tab to see how much reached your receiving wallet, when, and whether it carries the paying wallet’s confirmation signature. Order numbers are not recorded on the chain, so match the amount and time to the order. Payments from these links do not appear in your OpenPay history.',
    },
    {
      q: 'How do I receive orders from a “Reusable” link?',
      a: 'After paying, the customer uses “Send your order” on the completion screen to send a message with the items, amount, Tx Hash and confirmation signature to the LINE Official Account or email you set. They add their name and delivery address to that message. Nothing goes into OpenPay’s screens or servers. If you have not set a destination, the customer shares or copies the message instead. LINE works with Official Accounts only, and customers who have not added yours as a friend are asked to add it first.',
    },
    {
      q: 'What is the confirmation signature?',
      a: 'A signature the customer makes with the wallet they paid from, over a fixed text (your shop and the Tx Hash). No money moves. Anyone can see a Tx Hash, so you may get an order that pastes someone else’s payment. “Check a payment” confirms that the signature comes from the owner of the wallet that made the payment. That is all it shows: a message can be forwarded, so it does not prove who sent it or that the delivery address is right. Post your links on your official social media or site so that altered links are harder to spread.',
    },
    {
      q: 'Can I accept more than one receiving chain?',
      a: 'Yes. Pick two or more receiving chains in Settings and customers choose a chain before paying; whichever they choose, the payment reaches the same shop wallet. “Check a payment” searches every chain you picked and shows which one was used. Contract wallets such as Safe can have different owners on each chain, so pick only one receiving chain for them. With two or more, the screen checks on-chain and stops, but it cannot spot a wallet that has never been used yet.',
    },
    {
      q: 'Can I give a discount?',
      a: 'Yes. Use “Add discount” to enter an amount or a percentage, and the customer’s screen shows the subtotal, the discount and the amount to pay. A percentage applies to the item total, not to shipping. The “Ship after … JPYC reaches your wallet” amount also uses the discounted total. The discount goes only into the link you are making and is cleared by “Next order”.',
    },
    {
      q: 'Can I handle consumption tax and invoices?',
      a: 'Yes. Pick a tax rate under Consumption tax in “Settings”. You can change the rate per item, and the customer’s receipt shows the tax rate and the consumption tax. Shipping is taxed at the standard rate. Add your invoice registration number and shop name too, and for orders with a taxed item or shipping the receipt shows the number with the amount and consumption tax per rate (for business customers). On the receipt a discount is split across tax rates in proportion to their amounts (as at the register). The tax rate and number only appear on the receipt and are not kept in your OpenPay history, so keep your own records for bookkeeping.',
    },
    {
      q: 'What if I need to change the amount or items after sending?',
      a: 'Make a new link and send it again. A sent link cannot be cancelled and does not expire, so tell the customer which link to pay.',
    },
    {
      q: 'How do refunds work?',
      a: 'Blockchain transfers cannot be reversed, so the shop sends the refund from its own wallet to the customer’s wallet. OpenPay is not a party to the sale and cannot refund on your behalf.',
    },
    {
      q: 'How do I get the shipping address?',
      a: 'Collect the name and shipping address with the order form or messages you already use, or from the order the customer sends from a “Reusable” link (nothing is sent to OpenPay). If you make shipping labels in the Japan Post app, you can accept a Japan Post digital address (a 7-character code) instead of a full address, so customers type less. A digital address does not include a name, so ask for the name separately. Once you have shipped, do not keep the digital address (it keeps pointing to the customer’s address even after they move).',
    },
    {
      q: 'Do customers need an app?',
      a: 'No OpenPay app is needed. Customers open the link in their browser and pay from their own wallet. For customers without a wallet, point them to the “Choosing a wallet” guide.',
    },
  ],

  ctaTitle: 'Make your first link',
  ctaBody:
    'Set your receiving wallet, enter the items and prices, and the link is ready. At first, use “Open and check” to see the customer’s screen before you send it.',
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
