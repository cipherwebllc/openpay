// Cloudflare の公開エッジ IP レンジ (https://www.cloudflare.com/ips-v4 / ips-v6・2026-09-06 取得)。
//
// なぜ要るか: open-pay.jp は Cloudflare 配下 (`server: cloudflare`) なので、Vercel が見る接続元
// (`x-vercel-forwarded-for`) は Cloudflare のエッジ IP になり、リクエストごとに
// 変わる。IP 固定窓のレート制限 (`checkReadRateLimit` 等) のキーがばらけて上限に達しない
// (2026-09-06 に 160 req / 4 秒でも 429 が出ないことで発覚)。真の利用者 IP は Cloudflare が付ける
// `cf-connecting-ip` にだけ在る。
//
// ただし `cf-connecting-ip` を無条件に信じると、Cloudflare を迂回して Vercel の *.vercel.app を直接
// 叩く攻撃者が任意の値を偽装してレート制限のキーを選べてしまう。**Vercel 由来の接続元が Cloudflare のレンジの
// ときだけ** `cf-connecting-ip` を採用する (それ以外は従来どおり接続元 IP)。
//
// レンジは滅多に変わらないが、変わると Cloudflare 経由の全リクエストが「Cloudflare でない」扱いに
// 戻る (= 障害ではなく従来挙動に退化) だけなので fail-safe。更新時は上記 URL から貼り直す。

import { parseIp } from '@/lib/net/ipParse';

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

type Cidr = { base: bigint; bits: number; width: number };

// 厳密な `<ip>/<prefix>` だけを受理する (`a/`・`a/0/junk` を /0 として通さない — レビュー指摘)。
const CIDR_RE = /^([^/\s]+)\/(0|[1-9]\d{0,2})$/;

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
