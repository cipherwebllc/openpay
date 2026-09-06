import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_IPV4_CIDRS,
  CLOUDFLARE_IPV6_CIDRS,
  ipInCidr,
  isCloudflareIp,
} from '@/lib/net/cloudflareIps';

describe('ipInCidr', () => {
  it('IPv4: 境界の内外を正しく判定する', () => {
    expect(ipInCidr('104.16.0.0', '104.16.0.0/13')).toBe(true);
    expect(ipInCidr('104.23.255.255', '104.16.0.0/13')).toBe(true);
    expect(ipInCidr('104.24.0.0', '104.16.0.0/13')).toBe(false); // 次のブロック
    expect(ipInCidr('104.15.255.255', '104.16.0.0/13')).toBe(false);
    expect(ipInCidr('10.0.0.1', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(ipInCidr('10.0.0.2', '10.0.0.1/32')).toBe(false);
  });

  it('IPv6: 圧縮表記・展開表記・境界を正しく判定する', () => {
    expect(ipInCidr('2606:4700::1', '2606:4700::/32')).toBe(true);
    expect(ipInCidr('2606:4700:ffff:ffff:ffff:ffff:ffff:ffff', '2606:4700::/32')).toBe(true);
    expect(ipInCidr('2606:4701::', '2606:4700::/32')).toBe(false);
    expect(ipInCidr('2a06:98c0::1', '2a06:98c0::/29')).toBe(true);
    expect(ipInCidr('2a06:98c7:ffff::1', '2a06:98c0::/29')).toBe(true); // /29 = 下位 3bit 自由
    expect(ipInCidr('2a06:98c8::1', '2a06:98c0::/29')).toBe(false);
    // IPv6 側のレンジ表記が IPv4 埋め込み (::ffff:) の場合は両者とも IPv4 に unmap して判定される
    expect(ipInCidr('::ffff:104.16.0.1', '::ffff:104.16.0.0/109')).toBe(false); // /109 は IPv4 幅 (32) を超える
    expect(ipInCidr('::ffff:104.16.0.1', '::ffff:104.16.0.0/13')).toBe(true);
  });

  it('IPv4 と IPv6 のレンジを混同しない・不正入力は false', () => {
    expect(ipInCidr('104.16.0.1', '2606:4700::/32')).toBe(false);
    expect(ipInCidr('2606:4700::1', '104.16.0.0/13')).toBe(false);
    expect(ipInCidr('not-an-ip', '104.16.0.0/13')).toBe(false);
    expect(ipInCidr('104.16.0.1', '104.16.0.0/33')).toBe(false);
    expect(ipInCidr('104.16.0.1', '104.16.0.0')).toBe(false);
    // 壊れた CIDR を /0 (全許可) に化けさせない (レビュー指摘)
    expect(ipInCidr('104.16.0.1', '104.16.0.0/')).toBe(false);
    expect(ipInCidr('104.16.0.1', '104.16.0.0/0/junk')).toBe(false);
    expect(ipInCidr('104.16.0.1', '104.16.0.0/ 13')).toBe(false);
    expect(ipInCidr('104.16.0.1', '104.16.0.0/00')).toBe(false);
    expect(ipInCidr('104.16.0.1', '104.16.0.0/013')).toBe(false);
    expect(ipInCidr('2606:4700::1', '2606:4700::/032')).toBe(false);
  });

  it('IPv4-mapped IPv6 は IPv4 として判定する (レビュー指摘: Node/Vercel が ::ffff: 形で渡す場合)', () => {
    expect(ipInCidr('::ffff:104.16.0.1', '104.16.0.0/13')).toBe(true);
    expect(ipInCidr('::ffff:6810:1', '104.16.0.0/13')).toBe(true); // = 104.16.0.1 (圧縮表記)
    expect(ipInCidr('::ffff:680a:1', '104.16.0.0/13')).toBe(false); // = 104.10.0.1 は /13 の外
    expect(ipInCidr('::ffff:203.0.113.9', '104.16.0.0/13')).toBe(false);
    expect(isCloudflareIp('::ffff:172.71.0.1')).toBe(true);
    expect(isCloudflareIp('::ffff:ac47:1')).toBe(true); // 同上の圧縮表記
    expect(isCloudflareIp('::ffff:203.0.113.9')).toBe(false);
  });
});

describe('isCloudflareIp', () => {
  it('公開レンジの代表 IP を Cloudflare と判定し、それ以外は判定しない', () => {
    expect(isCloudflareIp('172.71.0.1')).toBe(true); // 172.64.0.0/13
    expect(isCloudflareIp('104.20.5.6')).toBe(true); // 104.16.0.0/13
    expect(isCloudflareIp('2606:4700:3037::ac43:d0e5')).toBe(true);
    expect(isCloudflareIp('2a06:98c1:3120::1')).toBe(true);
    expect(isCloudflareIp('203.0.113.9')).toBe(false);
    expect(isCloudflareIp('2001:db8::1')).toBe(false);
    expect(isCloudflareIp('76.76.21.21')).toBe(false); // Vercel
    expect(isCloudflareIp('')).toBe(false);
  });

  it('レンジ表は全件 CIDR として妥当 (貼り間違い防止)', () => {
    for (const cidr of [...CLOUDFLARE_IPV4_CIDRS, ...CLOUDFLARE_IPV6_CIDRS]) {
      const [ip] = cidr.split('/');
      expect(ipInCidr(ip, cidr), cidr).toBe(true);
    }
    expect(CLOUDFLARE_IPV4_CIDRS.length).toBeGreaterThanOrEqual(10);
    expect(CLOUDFLARE_IPV6_CIDRS.length).toBeGreaterThanOrEqual(5);
  });
});
