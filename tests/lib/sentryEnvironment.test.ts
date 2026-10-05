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
  it.each(['localhost', 'LOCALHOST', 'app.localhost', 'my-mac.local', '127.0.0.1', '[::1]', '0.0.0.0', '10.0.0.5', '192.168.1.2', '172.16.0.1', '172.31.255.255'])(
    '%s は手元',
    (host) => expect(isLocalHostname(host)).toBe(true),
  );

  // 本番を local と誤って付けると mainnet の通知から漏れる。本番の入口と公開 IP は local にしない。
  it.each(['open-pay.jp', 'www.open-pay.jp', 'openpay-git-main-cipherwebs-projects.vercel.app', 'localhost.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1'])(
    '%s は手元ではない',
    (host) => expect(isLocalHostname(host)).toBe(false),
  );
});
