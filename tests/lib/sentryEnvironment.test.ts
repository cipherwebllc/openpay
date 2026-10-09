import { describe, expect, it } from 'vitest';
import { isLocalHostname, sentryEnvironment } from '@/lib/sentryEnvironment';

describe('sentryEnvironment', () => {
  it('本番はネットワーク名のまま・手元は local- を付ける', () => {
    expect(sentryEnvironment('mainnet', false)).toBe('mainnet');
    expect(sentryEnvironment('testnet', false)).toBe('testnet');
    expect(sentryEnvironment('mainnet', true)).toBe('local-mainnet');
    expect(sentryEnvironment(undefined, false)).toBe('unknown');
    expect(sentryEnvironment('', true)).toBe('local-unknown');
  });
});

describe('isLocalHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'app.localhost', 'my-mac.local', '127.0.0.1', '127.255.0.9', '[::1]', '0.0.0.0', '10.0.0.5', '192.168.1.2', '172.16.0.1', '172.31.255.255'])(
    '%s は手元',
    (host) => expect(isLocalHostname(host)).toBe(true),
  );

  // IPv6 の手元: ループバック・ULA (fc00::/7)・リンクローカル (fe80::/10)・IPv4 射影 (::ffff:) の私設アドレス。
  // window.location.hostname は角括弧付き ([fd00::1]) で来るので、その形と素の形の両方。
  it.each(['[fd00::1]', 'fd00::1', '[FC00::1]', '[fdab:cdef::10]', '[fe80::1]', '[FE80::a1b2:c3d4]', '[febf::1]', '[::ffff:127.0.0.1]', '[::ffff:192.168.1.2]', '[::ffff:10.0.0.5]', '[0:0:0:0:0:0:0:1]'])(
    '%s は手元 (IPv6)',
    (host) => expect(isLocalHostname(host)).toBe(true),
  );

  // 本番を local と誤って付けると mainnet の通知から漏れる。本番の入口と公開 IP は local にしない。
  it.each(['open-pay.jp', 'www.open-pay.jp', 'openpay-git-main-cipherwebs-projects.vercel.app', 'localhost.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1'])(
    '%s は手元ではない',
    (host) => expect(isLocalHostname(host)).toBe(false),
  );

  // 公開の IPv6・ULA/リンクローカルに似た形・IPv4 射影の公開アドレスは local にしない。
  it.each(['[2606:4700::1111]', '[2001:db8::1]', '[fc0::1]', '[fe7f::1]', '[fec::1]', '[::ffff:8.8.8.8]', '[::2]', '[::]'])(
    '%s は手元ではない (IPv6)',
    (host) => expect(isLocalHostname(host)).toBe(false),
  );
});
