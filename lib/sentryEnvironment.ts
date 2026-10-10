// Sentry の environment。本番 (Vercel 上) は NEXT_PUBLIC_NETWORK_ENV (mainnet / testnet) のまま、
// 手元の dev / next start / Playwright から送られる event は `local-<network>` にする。
// Sentry の通知は environment = mainnet だけに絞っているので、手元で mainnet 設定のまま動かした
// 検証のエラー (2026-09-21: localhost:3142 の HeadlessChrome が mainnet で上がった) が本番の通知に
// 混ざる波及を断つ。本番の event を local と誤って付けると通知から漏れるので、local と判定するのは
// 「確実に手元」と言える場合だけにする。

import { expandIpv6 } from '@/lib/net/privateHost';

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

function isLocalIpv4(host: string): boolean {
  return host === '0.0.0.0' || PRIVATE_IPV4.some((re) => re.test(host));
}

// IPv6 で「確実に手元」と言える範囲だけ: ループバック (::1)・ULA (fc00::/7)・リンクローカル (fe80::/10)・
// IPv4 射影 (::ffff:a.b.c.d) の手元 IPv4。文書用 (2001:db8::/32) や廃止済サイトローカル等 (lib/net/privateHost.ts の
// SSRF 用の広い一覧) は含めない (本番の event を local と誤って付けると mainnet の通知から漏れる)。
// ブラウザは hostname を正規化する ([::ffff:192.168.1.2] → [::ffff:c0a8:102]・0 の省略) ので、文字列の形ではなく
// 8 group に展開して判定する。読めない形は手元にしない (安全側)。
function isLocalIpv6(host: string): boolean {
  const g = expandIpv6(host);
  if (g === null) return false;
  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (リンクローカル)
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // ::ffff:a.b.c.d (IPv4 射影) は埋め込みの IPv4 で判定する。
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isLocalIpv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  return false;
}

/** ブラウザのページのホスト名が手元 (自分の PC か社内ネットワーク) か。本番は open-pay.jp / *.vercel.app。 */
export function isLocalHostname(hostname: string): boolean {
  // window.location.hostname は IPv6 を角括弧付き ([fd00::1]) で返す。
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':')) return isLocalIpv6(host);
  return isLocalIpv4(host);
}
