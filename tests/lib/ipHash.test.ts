import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientIp, hashIp } from '@/lib/net/ipHash';

const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger }));

const SECRET = '0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hashIp', () => {
  it('正規化 IP を domain separator 付き HMAC-SHA256 hex に決定的に変換する', () => {
    vi.stubEnv('IP_HASH_SECRET', SECRET);

    expect(hashIp('203.0.113.9')).toBe(
      'c38ffb025dba7ba49b3c69d1d3263cb1110ce511ae2bc70ce6ed3643bdfcf953',
    );
    expect(hashIp('203.0.113.9')).toBe(hashIp('203.0.113.9'));
  });

  it('secret 未設定・32 byte 未満・IP null/不正は null', () => {
    vi.stubEnv('IP_HASH_SECRET', '');
    expect(hashIp('203.0.113.9')).toBeNull();

    vi.stubEnv('IP_HASH_SECRET', 'short-secret');
    expect(hashIp('203.0.113.9')).toBeNull();

    vi.stubEnv('IP_HASH_SECRET', SECRET);
    expect(hashIp(null)).toBeNull();
    expect(hashIp('999.0.0.1')).toBeNull();
    expect(hashIp('not-an-ip')).toBeNull();
  });

  it('同じ IPv6 の展開表記と圧縮表記を同じ値へ正規化する', () => {
    vi.stubEnv('IP_HASH_SECRET', SECRET);

    const expanded = hashIp('2001:0DB8:0000:0000:0000:0000:0000:0001');
    expect(expanded).toBe(
      '9e38a0b5dc99bdf0d3f291c6185964bc9809c5c65e5a6693a70cc0ee58c440bc',
    );
    expect(hashIp('2001:db8::1')).toBe(expanded);
  });
});

// C3: secret 欠落/過短は「IP レート制限が全 endpoint で無効」を意味するが、hashIp=null は
// checkIpRateLimit で無音の allow になる。許可挙動は変えずに、構成ミスをプロセス 1 回だけ
// warn で可視化する (relay hot path のログスパムを避けるため 1 回限り)。
describe('hashIp の IP_HASH_SECRET 欠落警告', () => {
  beforeEach(() => {
    vi.resetModules(); // module-level の warned フラグを毎テストで初期化する
    logger.warn.mockClear();
  });

  it('secret 欠落は 2 回呼んでも warn は 1 回だけ (許可挙動は不変)', async () => {
    vi.stubEnv('IP_HASH_SECRET', '');
    const { hashIp: fresh } = await import('@/lib/net/ipHash');

    expect(fresh('203.0.113.9')).toBeNull();
    expect(fresh('198.51.100.4')).toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('ratelimit.ip_hash_disabled', {
      reason: 'secret_missing',
      minBytes: 32,
    });
  });

  it('secret 過短は reason=secret_too_short で 1 回だけ warn', async () => {
    vi.stubEnv('IP_HASH_SECRET', 'short-secret');
    const { hashIp: fresh } = await import('@/lib/net/ipHash');

    expect(fresh('203.0.113.9')).toBeNull();
    expect(fresh('203.0.113.9')).toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('ratelimit.ip_hash_disabled', {
      reason: 'secret_too_short',
      minBytes: 32,
    });
  });

  it('secret が正しければ warn を出さない', async () => {
    vi.stubEnv('IP_HASH_SECRET', SECRET);
    const { hashIp: fresh } = await import('@/lib/net/ipHash');

    expect(fresh('203.0.113.9')).not.toBeNull();
    // IP 側が不正で null になるケースでも secret 起因の warn は出さない。
    expect(fresh('not-an-ip')).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('clientIp', () => {
  it('x-vercel-forwarded-for を x-forwarded-for より優先する', () => {
    const req = new Request('https://example.test', {
      headers: {
        'x-vercel-forwarded-for': '2001:0DB8:0:0:0:0:0:1',
        'x-forwarded-for': '203.0.113.8, 10.0.0.1',
      },
    });

    expect(clientIp(req)).toBe('2001:db8::1');
  });

  it('x-forwarded-for の先頭 hop を取り出す', () => {
    const req = new Request('https://example.test', {
      headers: { 'x-forwarded-for': ' 203.0.113.8, 10.0.0.1 ' },
    });

    expect(clientIp(req)).toBe('203.0.113.8');
  });

  it('優先 header が不正、または両 header 欠落なら null', () => {
    const invalidPreferred = new Request('https://example.test', {
      headers: {
        'x-vercel-forwarded-for': 'invalid',
        'x-forwarded-for': '203.0.113.8',
      },
    });

    expect(clientIp(invalidPreferred)).toBeNull();
    expect(clientIp(new Request('https://example.test'))).toBeNull();
  });
});
