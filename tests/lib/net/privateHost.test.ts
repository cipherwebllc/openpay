import { describe, expect, it } from 'vitest';
import { isPrivateHost } from '@/lib/net/privateHost';

describe('isPrivateHost special-purpose ranges', () => {
  it.each([
    ['0.0.0.0/8', '0.0.0.0', '0.255.255.255'],
    ['10.0.0.0/8', '10.0.0.0', '10.255.255.255'],
    ['100.64.0.0/10', '100.64.0.0', '100.127.255.255'],
    ['127.0.0.0/8', '127.0.0.0', '127.255.255.255'],
    ['169.254.0.0/16', '169.254.0.0', '169.254.255.255'],
    ['172.16.0.0/12', '172.16.0.0', '172.31.255.255'],
    ['192.0.0.0/24', '192.0.0.0', '192.0.0.255'],
    ['192.0.2.0/24', '192.0.2.0', '192.0.2.255'],
    ['192.88.99.0/24', '192.88.99.0', '192.88.99.255'],
    ['192.168.0.0/16', '192.168.0.0', '192.168.255.255'],
    ['198.18.0.0/15', '198.18.0.0', '198.19.255.255'],
    ['198.51.100.0/24', '198.51.100.0', '198.51.100.255'],
    ['203.0.113.0/24', '203.0.113.0', '203.0.113.255'],
    ['224.0.0.0/4', '224.0.0.0', '239.255.255.255'],
    ['240.0.0.0/4', '240.0.0.0', '255.255.255.255'],
  ])('blocks both ends of %s, including mapped IPv6', (_cidr, first, last) => {
    for (const ip of [first, last]) {
      const octets = ip.split('.').map(Number);
      const hex = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
      for (const host of [ip, `${ip}.`, `::ffff:${ip}`, `::ffff:${hex}`, `[0:0:0:0:0:ffff:${hex}]`]) {
        expect(isPrivateHost(host), host).toBe(true);
      }
    }
  });

  it.each([
    ['::/128', '::', '0:0:0:0:0:0:0:0'],
    ['::1/128', '::1', '0:0:0:0:0:0:0:1'],
    ['::ffff:0:0:0/96', '::ffff:0:0:0', '::ffff:0:ffff:ffff'],
    ['64:ff9b::/96', '64:ff9b::', '64:ff9b::ffff:ffff'],
    ['64:ff9b:1::/48', '64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff'],
    ['100::/64', '100::', '100::ffff:ffff:ffff:ffff'],
    ['100:0:0:1::/64', '100:0:0:1::', '100:0:0:1:ffff:ffff:ffff:ffff'],
    ['2001::/32', '2001::', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:2::/48', '2001:2::', '2001:2:0:ffff:ffff:ffff:ffff:ffff'],
    ['2001:db8::/32', '2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2002::/16', '2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['3fff::/20', '3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['5f00::/16', '5f00::', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['fc00::/7', 'fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['fe80::/10', 'fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['fec0::/10', 'fec0::', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['ff00::/8', 'ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ])('blocks both ends of %s, compressed/expanded/bracketed', (_cidr, first, last) => {
    for (const host of [first, last, `[${first}]`, `[${last.toUpperCase()}]`]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it.each([
    '::ffff:0:127.0.0.1', '::ffff:0:169.254.169.254',
    '::ffff:0:8.8.8.8', '64:ff9b::169.254.169.254', '64:ff9b::8.8.8.8',
    '2002:7f00:1::', '2002:0808:0808::', '::192.0.2.1',
  ])('blocks translated/tunnel ranges and embedded special-purpose IPv4: %s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    '1.1.1.1', '8.8.8.8', '9.255.255.255', '11.0.0.0',
    '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0',
    '191.255.255.255', '192.0.1.0', '192.0.1.255', '192.0.3.0',
    '192.88.98.255', '192.88.100.0', '192.167.255.255', '192.169.0.0',
    '198.17.255.255', '198.20.0.0', '198.51.99.255', '198.51.101.0',
    '203.0.112.255', '203.0.114.0', '223.255.255.255',
    '93.184.216.34', '142.250.190.10',
  ])('keeps public IPv4 outside the ranges allowed, including mapped form: %s', (host) => {
    expect(isPrivateHost(host)).toBe(false);
    expect(isPrivateHost(`::ffff:${host}`)).toBe(false);
  });

  it.each([
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::200e',
    '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db9::', '2003::', '3fff:1000::',
    '::ffff:808:808', '0:0:0:0:0:ffff:808:808', '::8.8.8.8',
    'example.com', 'example.com.', 'FCM.GOOGLEAPIS.COM',
  ])('keeps public IPv6 and DNS names allowed: %s', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it.each(['localhost', 'LOCALHOST.', 'db.internal.', 'printer.local', '::bad::ip', '1:2:3:4:5:6:7::8'])('blocks local names and malformed IPv6: %s', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });
});
