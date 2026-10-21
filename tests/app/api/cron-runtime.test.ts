import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let GET: (request: Request) => Response;
const request = (authorization?: string) => new Request('https://open-pay.jp/api/cron/runtime', {
  headers: authorization ? { authorization } : {},
});

beforeEach(async () => {
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.resetModules();
  ({ GET } = await import('@/app/api/cron/runtime/route'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/cron/runtime', () => {
  it('秘密が一致すれば Node の版だけを返す (キャッシュさせない)', async () => {
    const res = GET(request('Bearer cron-test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ node: process.version });
  });

  it('秘密が無い・違うなら 401 で版を出さない', async () => {
    for (const authorization of [undefined, 'Bearer wrong', 'cron-test']) {
      const res = GET(request(authorization));
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(JSON.stringify(await res.json())).not.toContain(process.version);
    }
  });

  it('CRON_SECRET が未設定なら、どの header でも 401 (fail-closed)', async () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.resetModules();
    ({ GET } = await import('@/app/api/cron/runtime/route'));
    for (const authorization of [undefined, 'Bearer ', 'Bearer cron-test']) {
      expect(GET(request(authorization)).status).toBe(401);
    }
  });
});
