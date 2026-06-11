// ウォレット接続ボタンに出すアイコンの解決。
//
// 優先順:
//   1. EIP-6963 で provider 自身が告知するアイコン (connector.icon・data URI) —
//      実際にインストールされているウォレットの公式アイコンなので最優先。
//   2. connector の id/name から public/wallets/ の同梱 SVG へのマッピング
//      (walletConnect / coinbaseWallet など設定ベースの connector は icon を持たない)。
//   3. 汎用ウォレットアイコン (injectedWallet.svg) — 未知のウォレットでも
//      アイコン枠を揃え、テキストだけのボタンに戻さない。

/** 部分一致キーワード → public/wallets/ のファイル名。上から順に評価するので、
 *  短く誤爆しやすい語 (core / safe) は specific な語の後ろに置く。 */
const WALLET_ICON_MATCHERS: ReadonlyArray<readonly [string, string]> = [
  ['metamask', 'MetaMask.svg'],
  ['walletconnect', 'walletConnectWallet.svg'],
  ['coinbase', 'coinbaseWallet.svg'],
  ['phantom', 'phantomWallet.svg'],
  ['rabby', 'rabbyWallet.svg'],
  ['rainbow', 'rainbowWallet.svg'],
  ['brave', 'braveWallet.svg'],
  ['zerion', 'zerionWallet.svg'],
  ['argent', 'argentWallet.svg'],
  ['backpack', 'backpackWallet.svg'],
  ['binance', 'binanceWallet.svg'],
  ['ledger', 'ledgerWallet.svg'],
  ['ronin', 'roninWallet.svg'],
  ['taho', 'tahoWallet.svg'],
  ['best wallet', 'bestWallet.svg'],
  ['core', 'coreWallet.svg'],
  ['safe', 'safeWallet.svg'],
];

export const GENERIC_WALLET_ICON = '/wallets/injectedWallet.svg';

export function walletIconSrc(connector: {
  id?: string | undefined;
  name: string;
  icon?: string | undefined;
}): string {
  if (connector.icon) return connector.icon;
  const key = `${connector.id ?? ''} ${connector.name}`.toLowerCase();
  for (const [needle, file] of WALLET_ICON_MATCHERS) {
    if (key.includes(needle)) return `/wallets/${file}`;
  }
  return GENERIC_WALLET_ICON;
}
