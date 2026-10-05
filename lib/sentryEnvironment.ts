// Sentry の environment。本番 (Vercel 上) は NEXT_PUBLIC_NETWORK_ENV (mainnet / testnet) のまま、
// 手元の dev / next start / Playwright から送られる event は `local-<network>` にする。
// Sentry の通知は environment = mainnet だけに絞っているので、手元で mainnet 設定のまま動かした
// 検証のエラー (2026-09-21: localhost:3142 の HeadlessChrome が mainnet で上がった) が本番の通知に
// 混ざる波及を断つ。本番の event を local と誤って付けると通知から漏れるので、local と判定するのは
// 「確実に手元」と言える場合だけにする。

export function sentryEnvironment(network: string | undefined, local: boolean): string {
  const base = network || 'unknown';
  return local ? `local-${base}` : base;
}

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/** ブラウザのページのホスト名が手元 (自分の PC か社内ネットワーク) か。本番は open-pay.jp / *.vercel.app。 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '[::1]' || host === '::1' || host === '0.0.0.0') return true;
  return PRIVATE_IPV4.some((re) => re.test(host));
}
