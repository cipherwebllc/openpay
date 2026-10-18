// /guide/wallet「ウォレットを選ぶ」(お客様向け) の content SOT (ja/en)。2026-10-13 user「ウォレットを選ぶだけでページ作った方が良い」。
// 選び方・お店の QR の読み取り方・WalletConnect のつなぎ方をこの 1 ページにまとめ、「JPYC で支払う」(app/[locale]/guide/pay) と
// 「モバイルオーダーのやり方」(app/[locale]/guide/mobile-order) には短い案内 (summary) とこのページへのリンクだけを置く
// (components/guide/WalletSummary.tsx・片方だけ直してずれないよう文言は 1 か所に)。
// user 方針 (2026-10-13): MetaMask が基本・初めての方には JPYC EX が組み込まれたマイナウォレット / HashPort Wallet
// (どちらも OpenPay の決済完了まで user が確認済み)。マイナウォレットを先に出して推す (JPYC EX の本人確認にもマイナンバー
// カードを使うため・user「マイナウォレットを押したい」)。HashPort Wallet も推薦に残す (user「推薦から外すことはない」)。
// つなぎ方は WalletConnect で、一覧は英語なので検索の言葉まで書く。
// お店の QR (OpenPay の支払いの URL) は、ウォレットのアプリの QR 読み取りでは開けないことがある (2026-10-13 user が実機で確認:
// MetaMask は外部リンクとして開ける・マイナウォレットは動かない・HashPort Wallet は「支払い」で読むと「このQRコードでは
// 支払えません。支払い用QRをご確認ください。」と出る) → スマホのカメラか「スキャンして支払う」で読む。
// ⚠️ 料率・チェーン名・「無料」/free は書かない (tests/lib/walletGuide.test.ts が検査する)。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';
import { PAY_GUIDE_JPYC_NOTE } from '@/lib/payGuide';

export type WalletGuideStep = {
  readonly n: number;
  readonly title: string;
  readonly body: string;
};

/** サイト内のページへのリンク (path は locale なし・描画側で `/${locale}` を前に付ける)。 */
export type WalletGuideLink = {
  readonly path: string;
  readonly label: string;
};

export type WalletGuideContent = {
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly subtitle: string;
  readonly lead: string;
  /** ページの頭の行動ボタン (「スキャンして支払う」= /scan)。 */
  readonly scanCta: WalletGuideLink;

  /** 「JPYC で支払う」「モバイルオーダーのやり方」に置く短い案内と、このページへのリンクの文字。 */
  readonly summary: string;
  readonly summaryLink: string;

  readonly walletsTitle: string;
  readonly walletLead: string;
  /** id は描画側のアイコンの対応にだけ使う (MetaMask は同梱の公式 SVG・ほかは一般のアイコン。公式ロゴの素材は未入手)。 */
  readonly wallets: readonly { readonly id: 'metamask' | 'myna' | 'hashport'; readonly name: string; readonly body: string }[];
  readonly walletNote: string;
  /** 運営者の note 記事 (ウォレット準備〜換金・運用)。「JPYC で支払う」の jpycNoteLink と同じ記事・同じ名前 (test で照合)。 */
  readonly noteLink: { readonly href: string; readonly label: string };

  readonly scanTitle: string;
  readonly scanLead: string;
  readonly scanWays: readonly { readonly id: 'camera' | 'scan'; readonly name: string; readonly body: string }[];
  readonly scanNote: string;

  readonly wcTitle: string;
  readonly wcSteps: readonly WalletGuideStep[];
  /** パソコンで支払い画面を開いたときの WalletConnect の QR (お店の QR とは別)。 */
  readonly wcTip: string;

};

const JA: WalletGuideContent = {
  metaTitle: 'ウォレットを選ぶ — JPYC で支払うためのウォレットとつなぎ方',
  metaDescription:
    'OpenPay で JPYC を支払うためのウォレットの選び方。MetaMask が基本で、初めての方にはマイナウォレットや HashPort Wallet もおすすめ。お店の QR の読み取り方と、WalletConnect でのつなぎ方。',
  subtitle: 'JPYC で支払うための、ウォレットの選び方とつなぎ方。',
  lead: 'OpenPay で支払うには、JPYC が入った自分のウォレットが要ります。OpenPay のアプリのインストールや会員登録は要りません。おすすめのウォレットと、お店の QR の読み取り方、ウォレットのつなぎ方をまとめました。',
  scanCta: { path: '/scan', label: 'スキャンして支払う' },

  summary:
    'お店の QR は、スマホのカメラか「スキャンして支払う」で読み取ってください (マイナウォレットや HashPort Wallet のアプリの QR 読み取りでは開けません)。',
  summaryLink: 'ウォレットの選び方・QR の読み取り方・つなぎ方',

  walletsTitle: 'おすすめのウォレット',
  walletLead:
    'MetaMask が基本です。初めての方には、アプリの中に JPYC EX が組み込まれていて、JPYC を手に入れる (発行) ことも日本円に戻す (償還) こともアプリの中でできる、マイナウォレットや HashPort Wallet もおすすめです。',
  wallets: [
    {
      id: 'metamask',
      name: 'MetaMask',
      body: 'いちばん広く使われているウォレットです。MetaMask のアプリの中のブラウザで支払い画面を開くと、そのまま接続できます。',
    },
    {
      id: 'myna',
      name: 'マイナウォレット',
      body: 'マイナンバーカードを使うウォレットです。JPYC EX の本人確認にもマイナンバーカードを使うので、はじめての方に向いています。アプリの中で JPYC の発行・償還ができます。OpenPay には WalletConnect でつなぎます。',
    },
    {
      id: 'hashport',
      name: 'HashPort Wallet',
      body: 'アプリの中で JPYC の発行・償還ができます。OpenPay には WalletConnect でつなぎます。',
    },
  ],
  walletNote:
    'お店の受け取り用にも、同じウォレットが使えます。アプリの中で発行・償還するときも、JPYC EX の登録と本人確認が必要です。くわしくは各ウォレットと JPYC 公式の案内をご覧ください。',
  noteLink: { href: PAY_GUIDE_JPYC_NOTE, label: 'JPYC 運用ガイド (ウォレット準備〜換金・運用) — note' },

  scanTitle: 'お店の QR の読み取り方',
  scanLead: 'お店の QR は、次のどちらかで読み取ります。支払い画面が開いたら、そこでウォレットをつなぎます。',
  scanWays: [
    {
      id: 'camera',
      name: 'スマホのカメラ',
      body: 'カメラのアプリで QR を写すと、ブラウザで支払い画面が開きます。',
    },
    {
      id: 'scan',
      name: '「スキャンして支払う」',
      body: 'OpenPay の「決済」から開いて、「カメラを起動」で読み取ります。先にウォレットをつないでおけば、お店では読み取って承認するだけです。',
    },
  ],
  scanNote:
    'お店の QR は、ウォレットのアプリの QR 読み取りでは開けないことがあります。MetaMask は開けますが、マイナウォレットと HashPort Wallet は開けません (HashPort Wallet の「支払い」で読み取ると「このQRコードでは支払えません」と出ます)。スマホのカメラか「スキャンして支払う」で読み取ってください。',

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
      body: 'スマホでは「All Wallets」の一覧が出ます。検索欄に英語で「Myna」または「HashPort」と入れて、ウォレットを選びます (カタカナでは見つかりません)。ウォレットのアプリが開きます。',
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
  wcTip: 'パソコンで支払い画面を開いたときは、そこに出る接続用の QR を、スマホのウォレットのアプリで読み取ってつなぎます (お店の QR とは別のものです)。',

};

const EN: WalletGuideContent = {
  metaTitle: 'Choosing a wallet — wallets for paying with JPYC and how to connect them',
  metaDescription:
    'Which wallet to use for paying with JPYC on OpenPay. MetaMask is the standard; if you are new to wallets, MynaWallet and HashPort Wallet are good choices too. How to scan the shop’s QR and how to connect with WalletConnect.',
  subtitle: 'Which wallet to use for paying with JPYC, and how to connect it.',
  lead: 'To pay with OpenPay you need your own wallet with JPYC in it. You do not need to install an OpenPay app or sign up. Here are the recommended wallets, how to scan the shop’s QR, and how to connect your wallet.',
  scanCta: { path: '/scan', label: 'Scan to pay' },

  summary:
    'Scan the shop’s QR with your phone camera or with “Scan to pay” (the QR scanners in the MynaWallet and HashPort Wallet apps cannot open it).',
  summaryLink: 'Choosing a wallet, scanning the QR and connecting',

  walletsTitle: 'Recommended wallets',
  walletLead:
    'MetaMask is the standard. If you are new to wallets, MynaWallet and HashPort Wallet are good choices too: JPYC EX is built into these apps, so you can get JPYC (issuance) and turn it back into yen (redemption) inside the app.',
  wallets: [
    {
      id: 'metamask',
      name: 'MetaMask',
      body: 'The most widely used wallet. Open the payment screen in the browser inside the MetaMask app and it connects as is.',
    },
    {
      id: 'myna',
      name: 'MynaWallet',
      body: 'A wallet that uses the My Number Card (Japan’s individual number card). JPYC EX also uses the My Number Card for identity verification, so it suits first-time users. Issue and redeem JPYC inside the app. Connect it to OpenPay with WalletConnect.',
    },
    {
      id: 'hashport',
      name: 'HashPort Wallet',
      body: 'Issue and redeem JPYC inside the app. Connect it to OpenPay with WalletConnect.',
    },
  ],
  walletNote:
    'The same wallets work for receiving at your shop. Issuing or redeeming inside these apps still requires a JPYC EX account and identity verification. See the guidance from each wallet and from JPYC for details.',
  noteLink: { href: PAY_GUIDE_JPYC_NOTE, label: 'JPYC handling guide (wallet setup to redemption) — note (Japanese)' },

  scanTitle: 'Scanning the shop’s QR',
  scanLead: 'Scan the shop’s QR in one of these two ways. Once the payment screen opens, connect your wallet there.',
  scanWays: [
    {
      id: 'camera',
      name: 'Your phone camera',
      body: 'Point the camera app at the QR and the payment screen opens in your browser.',
    },
    {
      id: 'scan',
      name: '“Scan to pay”',
      body: 'Open it from “Pay” in OpenPay and scan with “Start camera”. If you connect your wallet beforehand, at the shop you only scan and approve.',
    },
  ],
  scanNote:
    'The QR scanner inside a wallet app may not open the shop’s QR. MetaMask can, but MynaWallet and HashPort Wallet cannot (scanning it with “支払い” (Pay) in HashPort Wallet shows a message that the QR cannot be used for payment). Scan with your phone camera or with “Scan to pay” instead.',

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
      body: 'On a phone, an “All Wallets” list appears. Type “Myna” or “HashPort” in the search box and pick your wallet. The wallet app opens.',
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
  wcTip: 'If you opened the payment screen on a computer, scan the connection QR shown there with the wallet app on your phone (this is not the shop’s QR).',

};

export function walletGuideContentFor(locale: string): WalletGuideContent {
  return locale === 'en' ? EN : JA;
}

export function walletGuideMetadata(locale: string): Metadata {
  const c = walletGuideContentFor(locale);
  return guidePageMetadata({
    locale,
    path: '/guide/wallet',
    title: `${c.metaTitle} · OpenPay`,
    description: c.metaDescription,
  });
}
