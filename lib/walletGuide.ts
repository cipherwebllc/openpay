// お客様のウォレットの案内 (選び方 + WalletConnect のつなぎ方) の content SOT (ja/en)。
// 「JPYC で支払う」(lib/payGuide.ts) と「モバイルオーダーのやり方」(app/[locale]/guide/mobile-order) の両方が使う
// (片方だけ直してずれないよう 1 か所に)。描画は components/guide/WalletChoice.tsx。
// user 方針 (2026-10-13): MetaMask が基本・初めての方には JPYC EX が組み込まれた HashPort Wallet / マイナウォレット
// (どちらも OpenPay の決済完了まで user が確認済み)。つなぎ方は WalletConnect で、一覧は英語なので検索の言葉まで書く。
// ⚠️ 料率・チェーン名・「無料」/free は書かない (tests/lib/payGuide.test.ts が payGuide 経由でこの文言も検査する)。

export type WalletGuideStep = {
  readonly n: number;
  readonly title: string;
  readonly body: string;
};

export type WalletGuideContent = {
  readonly walletTitle: string;
  readonly walletLead: string;
  readonly wallets: readonly { readonly name: string; readonly body: string }[];
  readonly walletNote: string;
  readonly wcTitle: string;
  readonly wcSteps: readonly WalletGuideStep[];
  readonly wcTip: string;
};

export const WALLET_GUIDE_JA: WalletGuideContent = {
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
};

export const WALLET_GUIDE_EN: WalletGuideContent = {
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
};

export function walletGuideContentFor(locale: string): WalletGuideContent {
  return locale === 'en' ? WALLET_GUIDE_EN : WALLET_GUIDE_JA;
}
