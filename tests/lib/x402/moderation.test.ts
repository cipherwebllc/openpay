import { describe, it, expect } from 'vitest';
import { isFreelyAccessible, isPrivateHost } from '@/lib/x402/moderation';

const fetchWith = (status: number): typeof fetch =>
  (async () => ({ status }) as Response) as unknown as typeof fetch;
const fetchThrows: typeof fetch = (async () => {
  throw new Error('network');
}) as unknown as typeof fetch;
const lookupPublic = async () => [{ address: '93.184.216.34' }]; // example.com (public)
const lookupPrivate = async () => [{ address: '127.0.0.1' }];
const lookupMixed = async () => [
  { address: '93.184.216.34' },
  { address: '169.254.169.254' }, // 1つでも private なら拒否
];

describe('lib/x402/moderation isFreelyAccessible', () => {
  it('200 (公開 IP に解決) → true (= 登録拒否対象)', async () => {
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchWith(200), lookup: lookupPublic }),
    ).toBe(true);
  });

  it.each([301, 302, 307, 308, 402, 401, 403, 404, 500, 503])(
    '非 200 (%i・3xx は redirect 非追跡) → false (= 通す)',
    async (status) => {
      expect(
        await isFreelyAccessible('https://x.test', {
          fetchImpl: fetchWith(status),
          lookup: lookupPublic,
        }),
      ).toBe(false);
    },
  );

  it('fetch エラー/タイムアウト → false (fail-open)', async () => {
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchThrows, lookup: lookupPublic }),
    ).toBe(false);
  });

  it('DNS が private IP に解決 → probe せず false (SSRF rebinding 防止)', async () => {
    let fetched = false;
    const fetchSpy: typeof fetch = (async () => {
      fetched = true;
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    expect(
      await isFreelyAccessible('https://evil.test', { fetchImpl: fetchSpy, lookup: lookupPrivate }),
    ).toBe(false);
    expect(fetched).toBe(false); // 内部宛 fetch を行わない
  });

  it('解決先に private が1つでも混ざれば → false', async () => {
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchWith(200), lookup: lookupMixed }),
    ).toBe(false);
  });

  it('DNS 解決失敗 → false (fail-open)', async () => {
    const lookupThrows = async () => {
      throw new Error('NXDOMAIN');
    };
    expect(
      await isFreelyAccessible('https://x.test', { fetchImpl: fetchWith(200), lookup: lookupThrows }),
    ).toBe(false);
  });

  it('実 node:dns (lookup 非注入)・localhost → 127.0.0.1 に解決し fetch せず false', async () => {
    // 既定 lookup (node:dns/promises) を実際に走らせる統合パス。localhost は常に loopback に解決され、
    // isPrivateHost が真 → probe (fetch) せず false。fetch が呼ばれたら SSRF ガード破れなので spy で検証。
    let fetched = false;
    const fetchSpy = (async () => {
      fetched = true;
      return { status: 200 } as Response;
    }) as unknown as typeof fetch;
    expect(await isFreelyAccessible('http://localhost', { fetchImpl: fetchSpy })).toBe(false);
    expect(fetched).toBe(false); // 解決先 127.0.0.1 が private → fetch しない
  });
});

describe('lib/x402/moderation isPrivateHost', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1', // CGNAT 100.64.0.0/10
    '100.127.255.255',
    '::1',
    '::ffff:127.0.0.1', // IPv4-mapped IPv6
    'fe80::1', // link-local
    'fc00::1', // ULA
    'fd12::34',
    'svc.local',
    'db.internal',
  ])('private/loopback %s → true', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each([
    'example.com',
    'api.aegis-ai.xyz',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '11.0.0.1',
    '100.63.0.1', // CGNAT 下限の直前
    '100.128.0.1', // CGNAT 上限の直後
    '2606:4700::1111', // 公開 IPv6 (Cloudflare)
  ])('public %s → false', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});
