// /guide/pay 「JPYC で支払う」(お客様向け) の content SOT (ja/en 同梱)。構成は 2026-10-12 user 承認。
// 長文を messages/*.json に置かない方針は lib/mobileOrderGuide.ts / lib/agentGuide.ts と同じ。h1 は目次の名前
// (lib/guideNav.ts の items.pay.label) を page が描画する。
//
// 本文は実際の画面の文言をそのまま引用する (「スキャンして支払う」「カメラを起動」「URL を貼り付けて続行」
// 「通常決済（ガス代は自分で負担）」など)。画面の文言を変えたら、ここも直す (tests/lib/payGuide.test.ts が
// messages の文言を含むことを検査する)。
// ⚠️ 料率・最低額・チェーン名・「無料」「0 円」は書かない (掟 14 の同期面を増やさない)。料金は /pricing へリンクで逃がす。
// ⚠️ OpenPay が JPYC を発行・販売・交換すると読める書き方をしない (入手は JPYC 公式へ案内する)。
// ⚠️ 「安全」「保証」などの断定をしない。署名の説明は画面 (components/SignReassurance.tsx) と同じ事実だけ。
// 署名の期限「5 分以内」は lib/jpycEip3009.ts の AUTHORIZATION_VALIDITY_WINDOW_SEC (中継・5 分) と、それより短い
// 「お店の端末で送る」の窓 (lib/storeDevicePayment.ts) の両方に当てはまる書き方 (test で照合する)。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';

// 運営者の note 記事「JPYC 運用ガイド (ウォレット準備〜換金・運用)」(lib/startGuide.ts の JPYC_NOTE_GUIDE と同じ・test で照合)。
export const PAY_GUIDE_JPYC_NOTE = 'https://note.com/masia02/n/ned04a4cdb00a';

export type PayGuideStep = {
  readonly n: number;
  readonly title: string;
  readonly body: string;
};

/** サイト内のページへのリンク (path は locale なし・描画側で `/${locale}` を前に付ける)。 */
export type PayGuideLink = {
  readonly path: `/${string}`;
  readonly label: string;
};

export type PayGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;

  readonly subtitle: string;
  readonly lead: string;
  /** ページの頭と末尾の行動ボタン (「スキャンして支払う」= /scan)。 */
  readonly scanCta: PayGuideLink;

  readonly needTitle: string;
  readonly need: readonly string[];

  // ウォレットを選ぶ・QR の読み取り方・WalletConnect の手順は /guide/wallet (lib/walletGuide.ts)。このページには短い案内だけを置く。

  readonly stepsTitle: string;
  readonly steps: readonly PayGuideStep[];
  readonly stepsTip: string;

  readonly signTitle: string;
  readonly signLead: string;
  readonly sign: readonly string[];
  readonly signNote: string;

  readonly receiptTitle: string;
  readonly receipt: readonly string[];
  readonly receiptNote: string;

  readonly jpycTitle: string;
  readonly jpycBody: readonly string[];
  readonly jpycCallout: string;
  readonly jpycLink: { readonly href: string; readonly label: string };
  // 運営者の note 記事 (ウォレット選び〜換金)。lib/startGuide.ts の導入前チェックリストと同じ記事・同じ名前。
  readonly jpycNoteLink: { readonly href: string; readonly label: string };

  readonly faqTitle: string;
  readonly faq: readonly { readonly q: string; readonly a: string }[];

  readonly relatedTitle: string;
  readonly related: readonly PayGuideLink[];

  readonly ctaTitle: string;
  readonly ctaBody: string;
};

// JPYC の入手先 (発行元の公式サイト)。lib/links.ts の JPYC EX と同じ URL (test で照合する)。
const JPYC_OFFICIAL = 'https://jpyc.co.jp/';

const JA: PayGuideContent = {
  metaTitle: 'JPYC で支払う — お店の QR を読み取って、自分のウォレットで支払い',
  metaDescription:
    'OpenPay の QR を置いているお店で、JPYC で支払う手順。用意するもの、支払いの流れ、署名で求められること、電子レシート、JPYC の手に入れ方、うまくいかないときの対処をまとめました。',

  subtitle: 'お店の QR を読み取って、自分のウォレットで承認するだけ。',
  lead: 'OpenPay のアプリや会員登録は要りません。代金はあなたのウォレットからお店へ直接送られ、OpenPay は預かりません。',
  scanCta: { path: '/scan', label: 'スキャンして支払う' },

  needTitle: '用意するもの',
  need: [
    'スマートフォン (カメラで QR を読めれば OK)',
    'JPYC が入った自分のウォレット (MetaMask が基本。初めての方にはマイナウォレットや HashPort Wallet も)',
    'ガスレス決済の QR なら、ガス代用の POL などは要りません (「通常決済（ガス代は自分で負担）」の QR では必要)',
  ],

  stepsTitle: '支払いの流れ',
  steps: [
    {
      n: 1,
      title: '「スキャンして支払う」を開く',
      body: 'OpenPay の「決済」から開きます (スマホは画面の下、パソコンは上)。ホーム画面に追加すると、次からアイコンひとつで開けます。',
    },
    {
      n: 2,
      title: 'ウォレットを接続する',
      body: '右上の「接続」から、JPYC が入ったウォレットを接続します。お店に行く前に接続しておくと、お店では読み取って署名するだけです。',
    },
    {
      n: 3,
      title: 'お店の QR を読み取る',
      body: '「カメラを起動」を押して、お店の QR を枠に収めます。カメラが使えないときは「URL を貼り付けて続行」に、支払いの URL を貼り付けます。',
    },
    {
      n: 4,
      title: '金額を確かめて「支払う」を押す',
      body: 'いちばん上の金額とネットワークを確かめて、「◯◯ JPYC を支払う」を押します。金額の入っていない QR では、お店に言われた金額を入力します。ネットワークの切り替えを求められたら、先に切り替えます。',
    },
    {
      n: 5,
      title: 'ウォレットで確かめて承認する',
      body: 'ウォレットの確認画面で、金額と送り先が支払い画面と同じかを確かめてから、承認 (署名) します。',
    },
    {
      n: 6,
      title: '完了画面と控えを確かめる',
      body: '「決済完了」と出たら、お店の人に画面を見せます。その下に控え (電子レシート) が出ます。',
    },
  ],
  stepsTip:
    'スマホのカメラアプリで QR を読み取っても、同じ支払い画面が開きます。その場合は、開いた画面でウォレットを接続します。',

  signTitle: '署名で求められること',
  signLead:
    'ガスレス決済でウォレットに求められるのは「署名」1 回だけです。同じ説明が「支払う」ボタンの上にも出ます。',
  sign: [
    '署名は 1 回だけ。この 1 回の支払いにだけ有効です',
    'Approve (利用許可) は求めません。残高へのアクセス権は渡りません',
    '動かせるのは、支払い画面に書かれた金額だけです',
    '送り先はこのお店だけです。OpenPay の決済コントラクトを通るときも、同じ取引の中でお店へ振り分けられます',
    '署名は 5 分以内に自動で失効し、1 回しか使えません',
  ],
  signNote:
    '「通常決済（ガス代は自分で負担）」の QR では、ふつうの送金の確認が出ます。どちらも、金額や送り先が支払い画面と違うときは承認しないでください。',

  receiptTitle: '控え (電子レシート)',
  receipt: [
    '支払いが終わると、控え (電子レシート) がこのブラウザに保存されます。サーバには送られません',
    'あとから「スキャンして支払う」の「電子レシート / 支払い控え」で見返せます',
    '控えを開くと、印刷・CSV や JSON での保存・コピーができます',
    '別の端末やブラウザでは見られず、ブラウザのデータを消すと消えます。残したい控えは、印刷か保存をしておいてください',
  ],
  receiptNote: '控えは支払いを確かめるためのもので、正式な領収書や税務上の書類ではありません。',

  jpycTitle: 'JPYC を手に入れる',
  jpycBody: [
    'JPYC は、発行元の JPYC EX で手に入ります (本人確認 → 発行予約 → 銀行振込)。マイナウォレットと HashPort Wallet なら、アプリの中から手続きできます。',
    'OpenPay は JPYC の発行・販売・交換をしていません。条件は変わることがあるので、JPYC 公式サイトで最新の情報を確かめてください。',
  ],
  jpycCallout:
    'JPYC EX のネットワークと、お店の QR のネットワークが同じとは限りません。必要なネットワークは、支払い画面のいちばん上で確かめられます。',
  jpycLink: { href: JPYC_OFFICIAL, label: 'JPYC 公式サイトで最新の情報を見る' },
  jpycNoteLink: { href: PAY_GUIDE_JPYC_NOTE, label: 'JPYC 運用ガイド (ウォレット準備〜換金・運用) — note' },

  faqTitle: 'うまくいかないとき',
  faq: [
    {
      q: '「ガスレス決済が一時的に利用できません」と出た',
      a: '混み合っているか、一時的に使えない状態です。ガス代用のトークン (POL など・画面に名前が出ます) があれば、「通常支払い（自分でガスを払う）に切り替える」でそのまま払えます (ガス代はあなたのウォレットから)。なければ、少し待ってからもう一度お試しください。',
    },
    {
      q: '「残高が不足しています」と出た',
      a: 'あといくら必要かが、画面に出ます。JPYC を足してから、もう一度お試しください。手に入れ方は「JPYC を手に入れる」をご覧ください。',
    },
    {
      q: '持っている JPYC と、お店の QR のネットワークが違う',
      a: '同じ JPYC でも、ネットワーク (チェーン) が違うと別の残高になり、そのままでは払えません。お持ちのネットワークで払えるか、お店に相談してください。どこにいくらあるかは「スキャンして支払う」の「保有残高」で確かめられます。',
    },
    {
      q: '「送信結果を確認中」「送信済み・確認待ち」と出た',
      a: '支払いは送られていて、結果を確かめているところです。二重に払わないよう、もう一度払わずに、画面の案内に従ってください。',
    },
    {
      q: '支払いを取り消したい・返金してほしい',
      a: 'ブロックチェーン上の送金は、あとから取り消せません。払い間違えや返金は、お店に相談してください。返金はお店からあなたのウォレットへの別の送金で、代金を預からない OpenPay からは返金できません。',
    },
    {
      q: 'スマホでウォレットにつながらない',
      a: 'MetaMask などウォレットアプリの中のブラウザで開くと、接続と署名がスムーズです (画面に「MetaMask で開く」が出たら押します)。マイナウォレットや HashPort Wallet は「WalletConnect」から、検索欄に「Myna」「HashPort」と入れて選びます。',
    },
    {
      q: '手数料はかかる？',
      a: '支払う金額は、支払い画面の明細に出ます。ガスレス決済の QR ならガス代は要りません。「通常決済（ガス代は自分で負担）」の QR では、ウォレットからガス代が払われます。OpenPay の利用料とだれが払うかは「料金」にまとめています。',
    },
  ],

  relatedTitle: '関連ガイド',
  related: [
    { path: '/guide/mobile-order', label: 'モバイルオーダーのやり方' },
    { path: '/guide/agent', label: 'AI に頼んで注文（訪日客向け）' },
    { path: '/pricing', label: '料金 — 機能ごとに、だれが払うか' },
  ],

  ctaTitle: 'お店に行く前に、準備しておく',
  ctaBody:
    '「スキャンして支払う」でウォレットを接続し、残高を確かめておけば、お店では読み取って署名するだけです。',
};

const EN: PayGuideContent = {
  metaTitle: 'Pay with JPYC — scan the shop’s QR and pay from your own wallet',
  metaDescription:
    'How to pay with JPYC at shops that display an OpenPay QR code: what you need, the steps, what the signature asks for, digital receipts, how to get JPYC, and what to do when something goes wrong.',

  subtitle: 'Scan the shop’s QR code, then approve in your own wallet.',
  lead: 'No OpenPay app and no sign-up. The payment goes straight from your wallet to the shop; OpenPay never holds it.',
  scanCta: { path: '/scan', label: 'Scan to pay' },

  needTitle: 'What you need',
  need: [
    'A smartphone (any camera that can scan a QR)',
    'Your own wallet with JPYC in it (MetaMask is the standard; MynaWallet or HashPort Wallet are good choices if you are new to wallets)',
    'For a gasless QR you need no POL or other gas token (a QR marked “Standard (you pay gas)” does)',
  ],

  stepsTitle: 'How to pay',
  steps: [
    {
      n: 1,
      title: 'Open “Scan to pay”',
      body: 'Open it from “Pay” in OpenPay (bottom on a phone, top on a computer). Add it to your home screen to open it with one tap next time.',
    },
    {
      n: 2,
      title: 'Connect your wallet',
      body: 'Use “Connect” at the top right to connect the wallet that holds your JPYC. Connect before you go, and at the shop you only scan and sign.',
    },
    {
      n: 3,
      title: 'Scan the shop’s QR code',
      body: 'Tap “Start camera” and fit the shop’s QR in the frame. If the camera is not available, paste the payment URL into “Paste a URL instead”.',
    },
    {
      n: 4,
      title: 'Check the amount and tap “Pay”',
      body: 'Check the amount and network at the top, then tap “Pay ◯◯ JPYC”. For a QR without an amount, enter the amount the shop tells you. If asked to switch the network, switch it first.',
    },
    {
      n: 5,
      title: 'Check and approve in your wallet',
      body: 'On your wallet’s confirmation screen, check that the amount and recipient match the payment screen, then approve (sign).',
    },
    {
      n: 6,
      title: 'Check the completion screen and your receipt',
      body: 'When “Payment complete” appears, show the screen to the shop staff. Your digital receipt appears below it.',
    },
  ],
  stepsTip:
    'You can also scan the QR with your phone’s camera app; it opens the same payment screen. In that case, connect your wallet on the screen that opens.',

  signTitle: 'What the signature asks for',
  signLead:
    'For a gasless payment, your wallet asks for just one signature. The same summary appears above the “Pay” button.',
  sign: [
    'One signature, valid only for this one payment',
    'No Approve (spending allowance) is requested; no access to your balance is granted',
    'Only the amount written on the payment screen can move',
    'The funds go only to this shop. When they pass through OpenPay’s payment contract, it routes them to the shop within the same transaction',
    'The signature expires automatically within 5 minutes and can be used only once',
  ],
  signNote:
    'For a QR marked “Standard (you pay gas)”, you see an ordinary transfer confirmation. Either way, if the amount or recipient differs from the payment screen, do not approve.',

  receiptTitle: 'Your receipt (digital receipt)',
  receipt: [
    'When the payment completes, a payment record (digital receipt) is saved in this browser. It is never sent to a server',
    'You can look back at it later under “Payment receipts” in “Scan to pay”',
    'Open a receipt to print it, save it as CSV or JSON, or copy it',
    'It is not available on other devices or browsers, and clearing your browser data deletes it. Print or save any receipt you want to keep',
  ],
  receiptNote: 'The receipt is a payment reference, not an official receipt or tax document.',

  jpycTitle: 'Getting JPYC',
  jpycBody: [
    'You can get JPYC from JPYC EX, run by its issuer, for residents of Japan (identity check → reserve issuance → bank transfer). MynaWallet and HashPort Wallet let you do this from inside the app.',
    'OpenPay does not issue, sell or exchange JPYC. Conditions can change, so check the latest information on the JPYC official site.',
  ],
  jpycCallout:
    'The networks JPYC EX supports are not necessarily the network of the shop’s QR. The top of the payment screen shows which one you need.',
  jpycLink: { href: JPYC_OFFICIAL, label: 'See the latest on the JPYC official site' },
  jpycNoteLink: { href: PAY_GUIDE_JPYC_NOTE, label: 'JPYC handling guide (wallet setup to redemption) — note (Japanese)' },

  faqTitle: 'If something goes wrong',
  faq: [
    {
      q: '“Gasless payment is temporarily unavailable” appears',
      a: 'It is congested or temporarily unavailable. If you hold a gas token (such as POL — the screen shows its name), tap “Switch to standard payment (you pay gas)” to pay right away, with gas paid from your wallet. If not, wait a little and try again.',
    },
    {
      q: '“Insufficient balance” appears',
      a: 'The screen shows how much more you need. Add JPYC and try again. See “Getting JPYC” for how to get it.',
    },
    {
      q: 'My JPYC is on a different network from the shop’s QR',
      a: 'Even the same JPYC is a separate balance on each network, so it cannot pay as is. Ask the shop whether you can pay on your network. “Holdings” in “Scan to pay” shows how much you have on each.',
    },
    {
      q: '“Checking submission status” or “Submitted — awaiting confirmation” appears',
      a: 'Your payment has been sent and the result is being checked. To avoid paying twice, do not pay again; follow the on-screen guidance.',
    },
    {
      q: 'I want to cancel or get a refund',
      a: 'Blockchain transfers cannot be reversed. If you paid by mistake or want a refund, talk to the shop. A refund is a separate transfer from the shop to your wallet; OpenPay never holds payments, so it cannot refund you.',
    },
    {
      q: 'My wallet will not connect on my phone',
      a: 'Opening OpenPay in your wallet app’s browser (e.g. MetaMask) makes connecting and signing smoother (tap “Open in MetaMask” if it appears). For MynaWallet or HashPort Wallet, use “WalletConnect” and search for “Myna” or “HashPort”.',
    },
    {
      q: 'Are there any fees?',
      a: 'The amount you pay is shown in the breakdown on the payment screen. A gasless QR needs no gas; with a QR marked “Standard (you pay gas)”, gas is paid from your wallet. The OpenPay usage fee and who pays it are on the Pricing page.',
    },
  ],

  relatedTitle: 'Related guides',
  related: [
    { path: '/guide/mobile-order', label: 'How to use mobile order' },
    { path: '/guide/agent', label: 'Order with your AI (for visitors to Japan)' },
    { path: '/pricing', label: 'Pricing — who pays what, by feature' },
  ],

  ctaTitle: 'Get ready before you go',
  ctaBody:
    'Connect your wallet in “Scan to pay” and check your balance beforehand; at the shop you only scan and sign.',
};

/** 未知ロケールは ja (既存 guide の contentFor と同じ規約)。 */
export function payGuideContentFor(locale: string): PayGuideContent {
  return locale === 'en' ? EN : JA;
}

export function payGuideMetadata(locale: string): Metadata {
  const c = payGuideContentFor(locale);
  // OG/Twitter/canonical/hreflang は guide 共通ビルダーで (P5・N9)。OG 画像は既定 (og-home.webp)。
  return guidePageMetadata({
    locale,
    path: '/guide/pay',
    title: `${c.metaTitle} · OpenPay`,
    description: c.metaDescription,
  });
}
