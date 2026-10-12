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

  // ウォレットを選ぶ (MetaMask が基本・初めての方には JPYC EX が組み込まれた HashPort Wallet / マイナウォレット・2026-10-13 user)。
  // HashPort Wallet / マイナウォレットで OpenPay の決済完了まで確かめ済み (user)。つなぎ方は WalletConnect。
  readonly walletTitle: string;
  readonly walletLead: string;
  readonly wallets: readonly { readonly name: string; readonly body: string }[];
  readonly walletNote: string;
  readonly wcTitle: string;
  readonly wcSteps: readonly PayGuideStep[];
  readonly wcTip: string;

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
  lead: 'OpenPay の QR を置いているお店では、スマホで QR を読み取り、自分のウォレットで承認するだけで JPYC で支払えます。OpenPay のアプリのインストールや会員登録は要りません。代金はあなたのウォレットからお店のウォレットへ送られ、OpenPay は預かりません。',
  scanCta: { path: '/scan', label: 'スキャンして支払う' },

  needTitle: '用意するもの',
  need: [
    'スマートフォン (カメラで QR を読めれば OK)',
    'JPYC が入った自分のウォレット (MetaMask が基本です。初めての方には HashPort Wallet やマイナウォレットもおすすめ。下の「ウォレットを選ぶ」へ)',
    'ガスレス決済の QR なら、ガス代用の POL などは要りません (「通常決済（ガス代は自分で負担）」と出る QR では必要です)',
  ],

  walletTitle: 'ウォレットを選ぶ',
  walletLead:
    'MetaMask が基本です。初めての方には、アプリの中に JPYC EX が組み込まれていて、JPYC を手に入れる (発行) ことも日本円に戻す (償還) こともアプリの中でできる、HashPort Wallet やマイナウォレットもおすすめです。',
  wallets: [
    {
      name: 'MetaMask',
      body: 'いちばん広く使われているウォレットです。MetaMask のアプリの中のブラウザで支払い画面を開くと、そのまま接続できます。',
    },
    {
      name: 'HashPort Wallet',
      body: 'アプリの中で JPYC の発行・償還ができます。OpenPay には WalletConnect でつなぎます。',
    },
    {
      name: 'マイナウォレット',
      body: 'マイナンバーカードを使うウォレットです。アプリの中で JPYC の発行・償還ができます。OpenPay には WalletConnect でつなぎます。',
    },
  ],
  walletNote:
    'アプリの中で発行・償還するときも、JPYC EX の登録と本人確認が必要です。くわしくは各ウォレットと JPYC 公式の案内をご覧ください。',
  wcTitle: 'WalletConnect でつなぐ',
  wcSteps: [
    {
      n: 1,
      title: '「WalletConnect」を押す',
      body: '支払い画面の「ウォレット」、または「スキャンして支払う」の右上の「接続」から「WalletConnect」を押します。',
    },
    {
      n: 2,
      title: '英語の名前でウォレットを探す',
      body: 'スマホでは「All Wallets」の一覧が出ます。検索欄に英語で「HashPort」または「Myna」と入れて、ウォレットを選びます (カタカナでは見つかりません)。ウォレットのアプリが開きます。',
    },
    {
      n: 3,
      title: 'アプリで接続を承認する',
      body: 'ウォレットのアプリで接続を承認したら、ブラウザに戻ります。',
    },
    {
      n: 4,
      title: '支払いもアプリで承認する',
      body: '「支払う」を押すと、ウォレットのアプリに確認の画面が出ます (出ないときはアプリを開きます)。金額と送り先を確かめて承認し、ブラウザに戻ります。',
    },
  ],
  wcTip: 'パソコンで支払い画面を開いたときは、表示された QR を、スマホのウォレットのアプリで読み取ってつなぎます。',

  stepsTitle: '支払いの流れ',
  steps: [
    {
      n: 1,
      title: '「スキャンして支払う」を開く',
      body: 'OpenPay の「決済」から開きます (スマホでは画面の下、パソコンでは上)。ホーム画面に追加しておくと、次からはアイコンをタップするだけで開けます。',
    },
    {
      n: 2,
      title: 'ウォレットを接続する',
      body: '右上の「接続」から、JPYC が入ったウォレットを接続します。お店に行く前に接続しておけば、お店では QR を読み取って署名するだけです。接続すると、JPYC の残高もこの画面で確かめられます。',
    },
    {
      n: 3,
      title: 'お店の QR を読み取る',
      body: '「カメラを起動」を押して、お店の QR を枠に収めます。カメラが使えないときは「URL を貼り付けて続行」に、お店から受け取った支払いの URL を貼り付けます。読み取ると、支払い画面が開きます。',
    },
    {
      n: 4,
      title: '金額を確かめて「支払う」を押す',
      body: '支払い画面のいちばん上に、金額とネットワークが出ます。金額を確かめて、「◯◯ JPYC を支払う」のような金額入りのボタンを押します。金額の入っていない QR では、お店に言われた金額を入力します。ネットワークの切り替えを求められたら、先に切り替えます。',
    },
    {
      n: 5,
      title: 'ウォレットで確かめて承認する',
      body: 'ウォレットのアプリに確認画面が出ます。金額と送り先が支払い画面の表示と同じかを確かめてから、承認 (署名) します。',
    },
    {
      n: 6,
      title: '完了画面と控えを確かめる',
      body: '「決済完了」と出たら、お店の人に画面を見せて、確かめてもらったら閉じます。その下に、支払いの控え (電子レシート) が出ます。',
    },
  ],
  stepsTip:
    'スマホのカメラアプリで QR を読み取っても、同じ支払い画面が開きます。その場合は、開いた画面でウォレットを接続します。',

  signTitle: '署名で求められること',
  signLead:
    'ガスレス決済では、ウォレットで求められるのは「署名」1 回だけです。署名で何が起きるかは、支払い画面の「支払う」ボタンの上にも出ます。',
  sign: [
    '署名は 1 回だけ。この 1 回の支払いにだけ有効です',
    'Approve (利用許可) は求めません。残高へのアクセス権は渡りません',
    '動かせるのは、支払い画面に書かれた金額だけです',
    '送り先はこのお店だけです。OpenPay の決済コントラクトを通るときも、同じ取引の中でお店へ振り分けられます',
    '署名は 5 分以内に自動で失効し、1 回しか使えません',
  ],
  signNote:
    '「通常決済（ガス代は自分で負担）」の QR では、ウォレットにふつうの送金の確認が出ます。どちらの場合も、金額や送り先が支払い画面の表示と違うときは、承認せずに止めてください。',

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
    'JPYC は、発行元の JPYC EX で手に入れられます。本人確認のうえ発行予約をし、指定の銀行口座へ日本円を振り込むと、登録したウォレットに JPYC が届きます。',
    'HashPort Wallet とマイナウォレットは、アプリの中に JPYC EX が組み込まれていて、アプリから発行・償還の手続きができます。',
    'OpenPay は JPYC の発行・販売・交換をしていません。手に入れ方や条件は変わることがあるので、JPYC 公式サイトで最新の情報を確かめてください。',
  ],
  jpycCallout:
    'JPYC EX が対応するネットワークと、お店の QR のネットワークが同じとは限りません。どのネットワークの JPYC が要るかは、支払い画面のいちばん上で確かめられます。',
  jpycLink: { href: JPYC_OFFICIAL, label: 'JPYC 公式サイトで最新の情報を見る' },
  jpycNoteLink: { href: PAY_GUIDE_JPYC_NOTE, label: 'JPYC 運用ガイド (ウォレット準備〜換金・運用) — note' },

  faqTitle: 'うまくいかないとき',
  faq: [
    {
      q: '「ガスレス決済が一時的に利用できません」と出た',
      a: 'ガスレス決済が混み合っているか、一時的に使えない状態です。ウォレットにガス代用のトークン (POL など。画面に名前が出ます) があれば、「通常支払い（自分でガスを払う）に切り替える」を押して、そのまま支払えます。このときのガス代は、あなたのウォレットから払われます。持っていないときは、少し時間をおいてからもう一度お試しください。',
    },
    {
      q: '「残高が不足しています」と出た',
      a: 'あといくら必要かが、画面に出ます。JPYC を足してから、もう一度お試しください。手に入れ方は「JPYC を手に入れる」をご覧ください。',
    },
    {
      q: '持っている JPYC と、お店の QR のネットワークが違う',
      a: '同じ JPYC でも、ネットワーク (チェーン) が違うと別の残高になり、そのままでは支払えません。お店に、お持ちの JPYC のネットワークで支払えるか相談してください。どのネットワークにいくらあるかは、「スキャンして支払う」の「保有残高」で確かめられます。',
    },
    {
      q: '「送信結果を確認中」「送信済み・確認待ち」と出た',
      a: '支払いはネットワークに送られていて、結果を確かめているところです。二重に払わないよう、もう一度支払わずに、画面の案内に従って結果を確かめてください。',
    },
    {
      q: '支払いを取り消したい・返金してほしい',
      a: 'ブロックチェーン上の送金は、あとから取り消せません。払い間違えたときや返金してほしいときは、お店に相談してください。返金は、お店からあなたのウォレットへの別の送金になります。OpenPay は代金を預かっていないため、OpenPay から返金することはできません。',
    },
    {
      q: 'スマホでウォレットにつながらない',
      a: 'MetaMask などウォレットアプリの中のブラウザで OpenPay を開くと、接続と署名がスムーズです。画面に「MetaMask で開く」が出たら、それを押してください。HashPort Wallet やマイナウォレットは「WalletConnect」から、検索欄に英語で「HashPort」「Myna」と入れて選びます。',
    },
    {
      q: '手数料はかかる？',
      a: '支払う金額は、支払い画面の明細に出ます。ガスレス決済の QR なら、ガス代を払う必要はありません。「通常決済（ガス代は自分で負担）」の QR では、ウォレットからガス代が払われます。OpenPay の利用料とだれが払うかは、「料金」のページにまとめています。',
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
    '「スキャンして支払う」でウォレットを接続し、JPYC の残高を確かめておけば、お店では QR を読み取って署名するだけです。',
};

const EN: PayGuideContent = {
  metaTitle: 'Pay with JPYC — scan the shop’s QR and pay from your own wallet',
  metaDescription:
    'How to pay with JPYC at shops that display an OpenPay QR code: what you need, the steps, what the signature asks for, digital receipts, how to get JPYC, and what to do when something goes wrong.',

  subtitle: 'Scan the shop’s QR code, then approve in your own wallet.',
  lead: 'At shops that display an OpenPay QR code, scan it with your phone and approve in your own wallet to pay in JPYC. There is no OpenPay app to install and no sign-up. The payment goes from your wallet to the shop’s wallet; OpenPay never holds it.',
  scanCta: { path: '/scan', label: 'Scan to pay' },

  needTitle: 'What you need',
  need: [
    'A smartphone (any camera that can scan a QR)',
    'Your own wallet with JPYC in it (MetaMask is the standard. If you are new to wallets, HashPort Wallet or MynaWallet are good choices too — see “Choosing a wallet” below)',
    'For a gasless QR you need no POL or other gas token (a QR marked “Standard (you pay gas)” does need one)',
  ],

  walletTitle: 'Choosing a wallet',
  walletLead:
    'MetaMask is the standard. If you are new to wallets, HashPort Wallet and MynaWallet are good choices too: JPYC EX is built into these apps, so you can get JPYC (issuance) and turn it back into yen (redemption) inside the app.',
  wallets: [
    {
      name: 'MetaMask',
      body: 'The most widely used wallet. Open the payment screen in the browser inside the MetaMask app and it connects as is.',
    },
    {
      name: 'HashPort Wallet',
      body: 'Issue and redeem JPYC inside the app. Connect it to OpenPay with WalletConnect.',
    },
    {
      name: 'MynaWallet',
      body: 'A wallet that uses the My Number Card (Japan’s individual number card). Issue and redeem JPYC inside the app. Connect it to OpenPay with WalletConnect.',
    },
  ],
  walletNote:
    'Issuing or redeeming inside these apps still requires a JPYC EX account and identity verification. See the guidance from each wallet and from JPYC for details.',
  wcTitle: 'Connecting with WalletConnect',
  wcSteps: [
    {
      n: 1,
      title: 'Tap “WalletConnect”',
      body: 'On the payment screen, tap “WalletConnect” under “Wallet”, or from “Connect” at the top right of “Scan to pay”.',
    },
    {
      n: 2,
      title: 'Search for the wallet by its English name',
      body: 'On a phone, an “All Wallets” list appears. Type “HashPort” or “Myna” in the search box and pick your wallet. The wallet app opens.',
    },
    {
      n: 3,
      title: 'Approve the connection in the app',
      body: 'Approve the connection in the wallet app, then return to the browser.',
    },
    {
      n: 4,
      title: 'Approve the payment in the app too',
      body: 'When you tap pay, a confirmation appears in the wallet app (open the app if it does not). Check the amount and the recipient, approve, then return to the browser.',
    },
  ],
  wcTip: 'If you opened the payment screen on a computer, scan the QR shown there with the wallet app on your phone to connect.',

  stepsTitle: 'How to pay',
  steps: [
    {
      n: 1,
      title: 'Open “Scan to pay”',
      body: 'Open it from “Pay” in OpenPay (at the bottom on a phone, at the top on a computer). Add it to your home screen and next time it opens with one tap.',
    },
    {
      n: 2,
      title: 'Connect your wallet',
      body: 'Use “Connect” at the top right to connect the wallet that holds your JPYC. Connect before you go to the shop, and at the shop you only scan the QR and sign. Once connected, this screen also shows your JPYC balance.',
    },
    {
      n: 3,
      title: 'Scan the shop’s QR code',
      body: 'Tap “Start camera” and fit the shop’s QR in the frame. If the camera is not available, open “Paste a URL instead” and paste the payment URL the shop gave you. The payment screen opens once the QR is read.',
    },
    {
      n: 4,
      title: 'Check the amount and tap “Pay”',
      body: 'The amount and the network are shown at the top of the payment screen. Check the amount, then tap the button with the amount on it, such as “Pay ◯◯ JPYC”. For a QR without an amount, enter the amount the shop tells you. If you are asked to switch the network, switch it first.',
    },
    {
      n: 5,
      title: 'Check and approve in your wallet',
      body: 'Your wallet app shows a confirmation screen. Check that the amount and the recipient match the payment screen, then approve (sign).',
    },
    {
      n: 6,
      title: 'Check the completion screen and your receipt',
      body: 'When “Payment complete” appears, show the screen to the shop staff and close it once they have checked. Your payment record (digital receipt) appears below.',
    },
  ],
  stepsTip:
    'You can also scan the QR with your phone’s camera app; it opens the same payment screen. In that case, connect your wallet on the screen that opens.',

  signTitle: 'What the signature asks for',
  signLead:
    'For a gasless payment, your wallet asks for just one signature. What the signature does is also shown on the payment screen, just above the “Pay” button.',
  sign: [
    'One signature, valid only for this one payment',
    'No Approve (spending allowance) is requested; no access to your balance is granted',
    'Only the amount written on the payment screen can move',
    'The funds go only to this shop. When they pass through OpenPay’s payment contract, it routes them to the shop within the same transaction',
    'The signature expires automatically within 5 minutes and can be used only once',
  ],
  signNote:
    'For a QR marked “Standard (you pay gas)”, your wallet shows an ordinary transfer confirmation. In either case, if the amount or the recipient differs from the payment screen, stop and do not approve.',

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
    'You can get JPYC from JPYC EX, run by its issuer (for residents of Japan). After identity verification, you reserve an issuance and transfer Japanese yen to the designated bank account, and the JPYC arrives in your registered wallet.',
    'HashPort Wallet and MynaWallet have JPYC EX built in, so you can start issuance and redemption from inside the app.',
    'OpenPay does not issue, sell or exchange JPYC. How to get it and the conditions can change, so check the latest information on the JPYC official site.',
  ],
  jpycCallout:
    'The networks JPYC EX supports are not necessarily the network of the shop’s QR. The top of the payment screen shows which network’s JPYC you need.',
  jpycLink: { href: JPYC_OFFICIAL, label: 'See the latest on the JPYC official site' },
  jpycNoteLink: { href: PAY_GUIDE_JPYC_NOTE, label: 'JPYC handling guide (wallet setup to redemption) — note (Japanese)' },

  faqTitle: 'If something goes wrong',
  faq: [
    {
      q: '“Gasless payment is temporarily unavailable” appears',
      a: 'Gasless payment is congested or temporarily unavailable. If your wallet holds a gas token (such as POL — the screen shows its name), tap “Switch to standard payment (you pay gas)” to pay right away. The gas is then paid from your wallet. If you do not have one, wait a little and try again.',
    },
    {
      q: '“Insufficient balance” appears',
      a: 'The screen shows how much more you need. Add JPYC and try again. See “Getting JPYC” for how to get it.',
    },
    {
      q: 'My JPYC is on a different network from the shop’s QR',
      a: 'Even the same JPYC is a separate balance on each network, so it cannot pay as is. Ask the shop whether you can pay on the network your JPYC is on. “Holdings” in “Scan to pay” shows how much you have on each network.',
    },
    {
      q: '“Checking submission status” or “Submitted — awaiting confirmation” appears',
      a: 'Your payment has been sent to the network and the result is being checked. To avoid paying twice, do not pay again; follow the on-screen guidance to check the result.',
    },
    {
      q: 'I want to cancel or get a refund',
      a: 'Transfers on a blockchain cannot be reversed afterwards. If you paid by mistake or want a refund, talk to the shop. A refund is a separate transfer from the shop to your wallet. OpenPay does not hold payments, so it cannot refund you.',
    },
    {
      q: 'My wallet will not connect on my phone',
      a: 'Opening OpenPay in the browser inside your wallet app (e.g. MetaMask) makes connecting and signing smoother. If “Open in MetaMask” appears on the screen, tap it. For HashPort Wallet or MynaWallet, use “WalletConnect” and type “HashPort” or “Myna” in the search box.',
    },
    {
      q: 'Are there any fees?',
      a: 'The amount you pay is shown in the breakdown on the payment screen. With a gasless QR you do not pay gas. With a QR marked “Standard (you pay gas)”, gas is paid from your wallet. The OpenPay usage fee and who pays it are on the Pricing page.',
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
    'Connect your wallet in “Scan to pay” and check your JPYC balance beforehand, and at the shop you only scan the QR and sign.',
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
