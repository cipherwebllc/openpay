// IP の整数化と IPv4-mapped IPv6 の正規化を共有する (副作用・server-only 依存なし)。
import { isIP } from 'node:net';

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

const V4_MAPPED_PREFIX = 0xffffn; // ::ffff:0:0/96 の上位 (128-32) bit = 0x0000...ffff

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4` / `::ffff:102:304`) なら埋め込まれた IPv4 の整数を返す。 */
function unmapIpv4(v6: bigint): bigint | null {
  return v6 >> 32n === V4_MAPPED_PREFIX ? v6 & 0xffffffffn : null;
}

// ip を (整数, 幅) に解釈する。IPv4-mapped IPv6 は IPv4 として扱う (Vercel/Node が `::ffff:` 形で
// 渡してきても Cloudflare の IPv4 レンジに当たるように — レビュー指摘)。
export function parseIp(ip: string): { value: bigint; width: 32 | 128 } | null {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return { value: v4, width: 32 };
  const v6 = ipv6ToInt(ip);
  if (v6 === null) return null;
  const mapped = unmapIpv4(v6);
  return mapped !== null ? { value: mapped, width: 32 } : { value: v6, width: 128 };
}

