// Cloudflare の公開エッジ IP レンジ (https://www.cloudflare.com/ips-v4 / ips-v6・2026-09-06 取得)。
//
// なぜ要るか: open-pay.jp は Cloudflare 配下 (`server: cloudflare`) なので、Vercel が見る接続元
// (`x-vercel-forwarded-for` / `x-forwarded-for`) は Cloudflare のエッジ IP になり、リクエストごとに
// 変わる。IP 固定窓のレート制限 (`checkReadRateLimit` 等) のキーがばらけて上限に達しない
// (2026-09-06 に 160 req / 4 秒でも 429 が出ないことで発覚)。真の利用者 IP は Cloudflare が付ける
// `cf-connecting-ip` にだけ在る。
//
// ただし `cf-connecting-ip` を無条件に信じると、Cloudflare を迂回して Vercel の *.vercel.app を直接
// 叩く攻撃者が任意の値を偽装してレート制限のキーを選べてしまう。**接続元が Cloudflare のレンジの
// ときだけ** `cf-connecting-ip` を採用する (それ以外は従来どおり接続元 IP)。
//
// レンジは滅多に変わらないが、変わると Cloudflare 経由の全リクエストが「Cloudflare でない」扱いに
// 戻る (= 障害ではなく従来挙動に退化) だけなので fail-safe。更新時は上記 URL から貼り直す。

import { isIP } from 'node:net';

export const CLOUDFLARE_IPV4_CIDRS: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export const CLOUDFLARE_IPV6_CIDRS: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

function ipv4ToInt(ip: string): bigint | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').reduce((acc, octet) => (acc << 8n) + BigInt(Number(octet)), 0n);
}

// IPv6 を 128bit 整数へ。`::` 圧縮と、末尾の IPv4 埋め込み表記 (::ffff:1.2.3.4) を展開する。
function ipv6ToInt(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const [head, rest] = text.split('::');
  const headParts = head === '' ? [] : head.split(':');
  const restParts = rest === undefined ? [] : rest === '' ? [] : rest.split(':');
  const missing = 8 - headParts.length - restParts.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) return null;
  const parts = [...headParts, ...Array<string>(missing).fill('0'), ...restParts];
  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    value = (value << 16n) + BigInt(parseInt(part, 16));
  }
  return value;
}

type Cidr = { base: bigint; bits: number; width: number };

// 厳密な `<ip>/<prefix>` だけを受理する (`a/`・`a/0/junk` を /0 として通さない — レビュー指摘)。
const CIDR_RE = /^([^/\s]+)\/(\d{1,3})$/;

const V4_MAPPED_PREFIX = 0xffffn; // ::ffff:0:0/96 の上位 (128-32) bit = 0x0000...ffff

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4` / `::ffff:102:304`) なら埋め込まれた IPv4 の整数を返す。 */
function unmapIpv4(v6: bigint): bigint | null {
  return v6 >> 32n === V4_MAPPED_PREFIX ? v6 & 0xffffffffn : null;
}

// ip を (整数, 幅) に解釈する。IPv4-mapped IPv6 は IPv4 として扱う (Vercel/Node が `::ffff:` 形で
// 渡してきても Cloudflare の IPv4 レンジに当たるように — レビュー指摘)。
function parseIp(ip: string): { value: bigint; width: 32 | 128 } | null {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return { value: v4, width: 32 };
  const v6 = ipv6ToInt(ip);
  if (v6 === null) return null;
  const mapped = unmapIpv4(v6);
  return mapped !== null ? { value: mapped, width: 32 } : { value: v6, width: 128 };
}

// レンジ側も同じ解釈 (IPv4-mapped の base は IPv4 レンジとして扱い、prefix は IPv4 幅で検証)。
function parseCidr(cidr: string): Cidr | null {
  const m = CIDR_RE.exec(cidr);
  if (!m) return null;
  const [, ip, prefix] = m;
  const bits = Number(prefix);
  const parsed = parseIp(ip);
  if (!parsed || bits > parsed.width) return null;
  return { base: parsed.value, bits, width: parsed.width };
}

function inCidr(value: bigint, width: number, cidr: Cidr): boolean {
  if (cidr.width !== width) return false;
  const shift = BigInt(width - cidr.bits);
  return value >> shift === cidr.base >> shift;
}

const V4 = CLOUDFLARE_IPV4_CIDRS.map(parseCidr).filter((c): c is Cidr => c !== null);
const V6 = CLOUDFLARE_IPV6_CIDRS.map(parseCidr).filter((c): c is Cidr => c !== null);

/** ip (正規化済みの IPv4/IPv6 文字列) が Cloudflare の公開エッジレンジに含まれるか。 */
export function isCloudflareIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  const list = parsed.width === 32 ? V4 : V6;
  return list.some((c) => inCidr(parsed.value, parsed.width, c));
}

/** テスト用: CIDR 判定の一次関数 (任意のレンジで検証できるように公開)。 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const range = parseCidr(cidr);
  const parsed = parseIp(ip);
  if (!range || !parsed) return false;
  return inCidr(parsed.value, parsed.width, range);
}

/**
 * 匿名化用のプレフィックス。IPv4 (と IPv4-mapped IPv6) は /24、IPv6 は /64 を **展開してから** 切る。
 * 従来の文字列切り出し (`split(':').slice(0, 4)`) は `2001:db8::1` を `2001:db8::1::/64` にして
 * 完全なアドレスを残していた (レビュー指摘・cf-connecting-ip で真の利用者 IP が流れるようになった
 * ため実害化)。IP でない入力は null。
 */
export function anonymizedIpPrefix(ip: string): string | null {
  const parsed = parseIp(ip.trim());
  if (!parsed) return null;
  if (parsed.width === 32) {
    const v = parsed.value;
    return `${(v >> 24n) & 0xffn}.${(v >> 16n) & 0xffn}.${(v >> 8n) & 0xffn}.0/24`;
  }
  const top = parsed.value >> 64n;
  const hextets = [48n, 32n, 16n, 0n].map((shift) => ((top >> shift) & 0xffffn).toString(16));
  return `${hextets.join(':')}::/64`;
}
