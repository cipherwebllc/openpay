import { describe, expect, it } from 'vitest';
import { anonymizedIpPrefix } from '@/lib/net/ipPrefix';
import { anonymizeIp } from '@/lib/relay/relayRoute';

// 2026-09-06: cf-connecting-ip で真の利用者 IP が流れるようになったため、匿名化が「文字列の切り出し」
// では足りない (圧縮 IPv6 `2001:db8::1` が `2001:db8::1::/64` = 完全なアドレスのまま残っていた)。
describe('anonymizeIp / anonymizedIpPrefix', () => {
  it('IPv4 は /24 に丸める', () => {
    expect(anonymizeIp('203.0.113.9')).toBe('203.0.113.0/24');
    expect(anonymizeIp('203.0.113.9, 172.71.0.1')).toBe('203.0.113.0/24'); // 先頭 hop
  });

  it('IPv6 は展開してから /64 に丸める (圧縮表記で完全なアドレスを残さない)', () => {
    expect(anonymizeIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(anonymizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(anonymizeIp('2001:DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8:0:0::/64');
    expect(anonymizeIp('::1')).toBe('0:0:0:0::/64');
    // 旧実装の出力 (下位ビットが残る) にならないこと
    expect(anonymizeIp('2001:db8::1')).not.toContain('::1::');
  });

  it('IPv4-mapped IPv6 は IPv4 として /24 に丸める', () => {
    expect(anonymizeIp('::ffff:203.0.113.9')).toBe('203.0.113.0/24');
    expect(anonymizeIp('::ffff:cb00:7109')).toBe('203.0.113.0/24');
  });

  it('IP でない入力は unknown (プレフィックス関数は null)', () => {
    expect(anonymizeIp('')).toBe('unknown');
    expect(anonymizeIp('not-an-ip')).toBe('unknown');
    expect(anonymizeIp('1.2.3')).toBe('unknown');
    expect(anonymizedIpPrefix('garbage')).toBeNull();
  });
});
