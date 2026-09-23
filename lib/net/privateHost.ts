// hostname / IP literal の SSRF 判定だけを持つ pure utility。DNS や Node 専用 module は import せず、
// 保存入口・接続 sink の双方から同じ literal 判定を利用できるようにする。

// SSRF 対策: private・非 unicast・文書用・移行用のレンジを拒否し、利用者が指定した
// endpoint からローカル/特殊用途の基盤へ接続する波及を断つ。
// 参照元 (2026-09-23 確認):
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// multicast: RFC 1112 / RFC 4291、廃止済 site-local: RFC 3879。
// 192.0.0.0/24 と変換/トンネル用レンジは、IANA にグローバル到達可能な例外があっても全体を拒否。
// IPv4-mapped はソケット上の IPv4 表現なので、以下の IPv4 ポリシーで判定する。
const IPV4_CIDRS = [
  ['0.0.0.0', 8], // 自ネットワーク
  ['10.0.0.0', 8], // プライベート
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // ループバック
  ['169.254.0.0', 16], // リンクローカル
  ['172.16.0.0', 12], // プライベート
  ['192.0.0.0', 24], // IETF プロトコル割り当て
  ['192.0.2.0', 24], // 文書用
  ['192.88.99.0', 24], // 廃止済 6to4 リレー
  ['192.168.0.0', 16], // プライベート
  ['198.18.0.0', 15], // ベンチマーク用
  ['198.51.100.0', 24], // 文書用
  ['203.0.113.0', 24], // 文書用
  ['224.0.0.0', 4], // マルチキャスト
  ['240.0.0.0', 4], // 予約済み (限定ブロードキャストを含む)
] as const;

const IPV6_CIDRS = [
  ['::', 128], // 未指定アドレス
  ['::1', 128], // ループバック
  ['::ffff:0:0:0', 96], // IPv4 変換用 (RFC 6145)
  ['64:ff9b::', 96], // NAT64 の既知プレフィックス
  ['64:ff9b:1::', 48], // ローカル利用向け NAT64
  ['100::', 64], // 破棄専用
  ['100:0:0:1::', 64], // ダミープレフィックス
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // ベンチマーク用
  ['2001:db8::', 32], // 文書用
  ['2002::', 16], // 6to4
  ['3fff::', 20], // 文書用
  ['5f00::', 16], // セグメントルーティングの SID
  ['fc00::', 7], // ULA
  ['fe80::', 10], // リンクローカル
  ['fec0::', 10], // 廃止済サイトローカル
  ['ff00::', 8], // マルチキャスト
] as const;

type Prefix = { groups: readonly number[]; bits: number };
const IPV4_PREFIXES: Prefix[] = IPV4_CIDRS.map(([base, bits]) => ({
  groups: base.split('.').map(Number), bits,
}));
const IPV6_PREFIXES: Prefix[] = IPV6_CIDRS.map(([base, bits]) => ({
  groups: expandIpv6(base)!, bits,
}));

// cloudflareIps.ipInCidr は node:net を取り込むため、ここでは Node 依存を持たずに判定する。
// group の途中で終わる CIDR も、プレフィックスに含まれる bit だけを比較する。
function matchesPrefix(address: readonly number[], prefix: Prefix, groupBits: number): boolean {
  for (let i = 0; i * groupBits < prefix.bits; i += 1) {
    const shift = Math.max(0, (i + 1) * groupBits - prefix.bits);
    if (address[i] >>> shift !== prefix.groups[i] >>> shift) return false;
  }
  return true;
}

function isPrivateIpv4(octets: number[]): boolean {
  return IPV4_PREFIXES.some((prefix) => matchesPrefix(octets, prefix, 8));
}

// IPv6 literal を 8 group (各 16bit) に展開する。末尾の埋め込み IPv4 も 2 group の hex にする。
function expandIpv6(hostname: string): number[] | null {
  let value = hostname;
  const embeddedV4 = value.match(
    /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (embeddedV4) {
    const octets = embeddedV4[2].split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    value = `${embeddedV4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1,
  );
  return numbers.some((number) => number < 0) ? null : numbers;
}

// URL.hostname の IPv6 brackets と FQDN root label を判定前に統一する。
export function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

// hostname / IP literal が SSRF 向けの禁止レンジなら true (DNS 解決は呼び手が行う)。
export function isPrivateHost(hostname: string): boolean {
  const host = normalizeHost(hostname.toLowerCase());
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  if (host.includes(':')) {
    const groups = expandIpv6(host);
    if (groups === null) return true;
    if (IPV6_PREFIXES.some((prefix) => matchesPrefix(groups, prefix, 16))) return true;
    if (
      groups.slice(0, 5).every((group) => group === 0) &&
      (groups[5] === 0xffff || groups[5] === 0)
    ) {
      return isPrivateIpv4([
        (groups[6] >> 8) & 0xff, groups[6] & 0xff,
        (groups[7] >> 8) & 0xff, groups[7] & 0xff,
      ]);
    }
    return false;
  }

  const ipv4 = host.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (ipv4) return isPrivateIpv4(ipv4.slice(1).map(Number));
  return false;
}
