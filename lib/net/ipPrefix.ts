import { parseIp } from '@/lib/net/ipParse';

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
