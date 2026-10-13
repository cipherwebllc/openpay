// /guide/wallet「ウォレットを選ぶ」(お客様向け) の content SOT (ja/en)。2026-10-13 user「ウォレットを選ぶだけでページ作った方が良い」。
// 選び方・お店の QR の読み取り方・WalletConnect のつなぎ方をこの 1 ページにまとめ、「JPYC で支払う」(app/[locale]/guide/pay) と
// 「モバイルオーダーのやり方」(app/[locale]/guide/mobile-order) には短い案内 (summary) とこのページへのリンクだけを置く
// (components/guide/WalletSummary.tsx・片方だけ直してずれないよう文言は 1 か所に)。
// user 方針 (2026-10-13): MetaMask が基本・初めての方には JPYC EX が組み込まれた HashPort Wallet / マイナウォレット
// (どちらも OpenPay の決済完了まで user が確認済み)。つなぎ方は WalletConnect で、一覧は英語なので検索の言葉まで書く。
// お店の QR (OpenPay の支払いの URL) は、ウォレットのアプリの QR 読み取りでは開かないものがある (MetaMask は開ける・
// マイナウォレットなどは開けない。2026-10-13 user が実機で確認) → スマホのカメラか「スキャンして支払う」で読む。
// ⚠️ 料率・チェーン名・「無料」/free は書かない (tests/lib/walletGuide.test.ts が検査する)。

import type { Metadata } from 'next';
import { guidePageMetadata } from '@/lib/guideMetadata';

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
  readonly wallets: readonly { readonly name: string; readonly body: string }[];
  readonly walletNote: string;

  readonly scanTitle: string;
  readonly scanLead: string;
  readonly scanWays: readonly { readonly name: string; readonly body: string }[];
  readonly scanNote: string;

  readonly wcTitle: string;
  readonly wcSteps: readonly WalletGuideStep[];
  /** パソコンで支払い画面を開いたときの WalletConnect の QR (お店の QR とは別)。 */
  readonly wcTip: string;

  readonly relatedTitle: string;
  readonly related: readonly WalletGuideLink[];
};

const JA: WalletGuideContent = {
  metaTitle: 'ウォレットを選ぶ — JPYC で支払うためのウォレットとつなぎ方',
  metaDescription:
    'OpenPay で JPYC を支払うためのウォレットの選び方。MetaMask が基本で、初めての方には HashPort Wallet やマイナウォレットもおすすめ。お店の QR の読み取り方と、WalletConnect でのつなぎ方。',
  subtitle: 'JPYC で支払うための、ウォレットの選び方とつなぎ方。',
  lead: 'OpenPay で支払うには、JPYC が入った自分のウォレットが要ります。OpenPay のアプリのインストールや会員登録は要りません。おすすめのウォレットと、お店の QR の読み取り方、ウォレットのつなぎ方をまとめました。',
  scanCta: { path: '/scan', label: 'スキャンして支払う' },

  summary:
    'MetaMask が基本です。初めての方には、アプリの中で JPYC の発行・償還ができる HashPort Wallet やマイナウォレットもおすすめです。お店の QR は、スマホのカメラか「スキャンして支払う」で読み取ってください (ウォレットのアプリの QR 読み取りでは開かないものがあります)。',
  summaryLink: 'ウォレットの選び方・QR の読み取り方・つなぎ方',

  walletsTitle: 'おすすめのウォレット',
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
    'お店の受け取り用にも、同じウォレットが使えます。アプリの中で発行・償還するときも、JPYC EX の登録と本人確認が必要です。くわしくは各ウォレットと JPYC 公式の案内をご覧ください。',

  scanTitle: 'お店の QR の読み取り方',
  scanLead: 'お店の QR は、次のどちらかで読み取ります。支払い画面が開いたら、そこでウォレットをつなぎます。',
  scanWays: [
    {
      name: 'スマホのカメラ',
      body: 'カメラのアプリで QR を写すと、ブラウザで支払い画面が開きます。',
    },
    {
      name: '「スキャンして支払う」',
      body: 'OpenPay の「決済」から開いて、「カメラを起動」で読み取ります。先にウォレットをつないでおけば、お店では読み取って承認するだけです。',
    },
  ],
  scanNote:
    'ウォレットのアプリの QR 読み取りでは、支払い画面が開かないものがあります。MetaMask は開けますが、マイナウォレットなどは開けません。そのときは、スマホのカメラか「スキャンして支払う」で読み取ってください。',

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
  wcTip: 'パソコンで支払い画面を開いたときは、そこに出る接続用の QR を、スマホのウォレットのアプリで読み取ってつなぎます (お店の QR とは別のものです)。',

  relatedTitle: '関連ガイド',
  related: [
    { path: '/guide/pay', label: 'JPYC で支払う' },
    { path: '/guide/mobile-order', label: 'モバイルオーダーのやり方' },
  ],
};

const EN: WalletGuideContent = {
  metaTitle: 'Choosing a wallet — wallets for paying with JPYC and how to connect them',
  metaDescription:
    'Which wallet to use for paying with JPYC on OpenPay. MetaMask is the standard; if you are new to wallets, HashPort Wallet and MynaWallet are good choices too. How to scan the shop’s QR and how to connect with WalletConnect.',
  subtitle: 'Which wallet to use for paying with JPYC, and how to connect it.',
  lead: 'To pay with OpenPay you need your own wallet with JPYC in it. You do not need to install an OpenPay app or sign up. Here are the recommended wallets, how to scan the shop’s QR, and how to connect your wallet.',
  scanCta: { path: '/scan', label: 'Scan to pay' },

  summary:
    'MetaMask is the standard. If you are new to wallets, HashPort Wallet and MynaWallet are good choices too: you can issue and redeem JPYC inside these apps. Scan the shop’s QR with your phone camera or with “Scan to pay” (some wallet apps cannot open it from their own QR scanner).',
  summaryLink: 'Choosing a wallet, scanning the QR and connecting',

  walletsTitle: 'Recommended wallets',
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
    'The same wallets work for receiving at your shop. Issuing or redeeming inside these apps still requires a JPYC EX account and identity verification. See the guidance from each wallet and from JPYC for details.',

  scanTitle: 'Scanning the shop’s QR',
  scanLead: 'Scan the shop’s QR in one of these two ways. Once the payment screen opens, connect your wallet there.',
  scanWays: [
    {
      name: 'Your phone camera',
      body: 'Point the camera app at the QR and the payment screen opens in your browser.',
    },
    {
      name: '“Scan to pay”',
      body: 'Open it from “Pay” in OpenPay and scan with “Start camera”. If you connect your wallet beforehand, at the shop you only scan and approve.',
    },
  ],
  scanNote:
    'Some wallet apps cannot open the payment screen from their own QR scanner. MetaMask can, but MynaWallet and some others cannot. In that case, scan with your phone camera or with “Scan to pay”.',

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
  wcTip: 'If you opened the payment screen on a computer, scan the connection QR shown there with the wallet app on your phone (this is not the shop’s QR).',

  relatedTitle: 'Related guides',
  related: [
    { path: '/guide/pay', label: 'Pay with JPYC' },
    { path: '/guide/mobile-order', label: 'How to use mobile order' },
  ],
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
