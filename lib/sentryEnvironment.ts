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

// IPv6 で「確実に手元」と言える範囲だけ: ULA (fc00::/7 = fc00〜fdff)・リンクローカル (fe80::/10 = fe80〜febf)。
// 文書用 (2001:db8::/32) や廃止済サイトローカル等 (lib/net/privateHost.ts の SSRF 用の広い一覧) は含めない
// (本番の event を local と誤って付けると mainnet の通知から漏れる)。
const PRIVATE_IPV6 = [/^f[cd][0-9a-f]{2}:/, /^fe[89ab][0-9a-f]:/];

/** 1 グループずつの IPv6 ループバック (0:0:0:0:0:0:0:1) か。 */
function isIpv6Loopback(host: string): boolean {
  const groups = host.split(':');
  return groups.length === 8 && groups.slice(0, 7).every((g) => /^0{1,4}$/.test(g)) && /^0{0,3}1$/.test(groups[7]);
}

/** ブラウザのページのホスト名が手元 (自分の PC か社内ネットワーク) か。本番は open-pay.jp / *.vercel.app。 */
export function isLocalHostname(hostname: string): boolean {
  // window.location.hostname は IPv6 を角括弧付き ([fd00::1]) で返す。
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0' || isIpv6Loopback(host)) return true;
  // IPv4 射影 (::ffff:192.168.1.2) は埋め込みの IPv4 で判定する。
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isLocalHostname(mapped[1]);
  return PRIVATE_IPV4.some((re) => re.test(host)) || PRIVATE_IPV6.some((re) => re.test(host));
}
