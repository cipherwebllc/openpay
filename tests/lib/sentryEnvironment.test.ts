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
  // ブラウザは URL の hostname を正規化する ([::ffff:192.168.1.2] → [::ffff:c0a8:102]・大文字 → 小文字・0 の省略) ので、
  // window.location.hostname と同じ形 (new URL(...).hostname) を渡す。
  it.each([
    'http://[::1]:3000',
    'http://[0:0:0:0:0:0:0:1]:3000',
    'http://[fd00::1]:3000',
    'http://[FC00::1]',
    'http://[fdab:cdef::10]',
    'http://[fe80::1]',
    'http://[FE80::a1b2:c3d4]',
    'http://[febf::1]',
    'http://[::ffff:127.0.0.1]:3000',
    'http://[::ffff:192.168.1.2]:3000',
    'http://[::ffff:10.0.0.5]',
    'http://[::ffff:172.16.0.1]',
    'http://[::ffff:7f00:1]',
    'http://[::ffff:c0a8:102]',
  ])('%s の hostname は手元 (IPv6)', (url) => expect(isLocalHostname(new URL(url).hostname)).toBe(true));

  // 本番を local と誤って付けると mainnet の通知から漏れる。本番の入口と公開 IP は local にしない。
  it.each(['open-pay.jp', 'www.open-pay.jp', 'openpay-git-main-cipherwebs-projects.vercel.app', 'localhost.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1'])(
    '%s は手元ではない',
    (host) => expect(isLocalHostname(host)).toBe(false),
  );

  // 公開の IPv6・ULA/リンクローカルに似た形・IPv4 射影の公開アドレス・読めない形は local にしない。
  it.each([
    'http://[2606:4700::1111]',
    'http://[2001:db8::1]',
    'http://[fc0::1]',
    'http://[fe7f::1]',
    'http://[fec::1]',
    'http://[::ffff:8.8.8.8]',
    'http://[::ffff:808:808]',
    'http://[::ffff:172.32.0.1]',
    'http://[::2]',
    'http://[::]',
    'http://[64:ff9b::7f00:1]',
  ])('%s の hostname は手元ではない (IPv6)', (url) => expect(isLocalHostname(new URL(url).hostname)).toBe(false));

  it('角括弧の無い IPv6 も読む・壊れた IPv6 は手元にしない (判定できない形は安全側)', () => {
    expect(isLocalHostname('fd00::1')).toBe(true);
    expect(isLocalHostname('[fd00:::1]')).toBe(false);
    expect(isLocalHostname('[fd00::zz]')).toBe(false);
    expect(isLocalHostname('[1:2:3:4:5:6:7:8:9]')).toBe(false);
  });
});
