import { afterEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return import('@/app/api/cron/reverify/route');
}

function request(token?: string): Request {
  return new Request('https://open-pay.jp/api/cron/reverify', {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/cron/reverify auth', () => {
  it('CRON_SECRET 未設定は bearer の有無にかかわらず401', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const route = await load();
    expect((await route.GET(request())).status).toBe(401);
    expect((await route.GET(request('guess'))).status).toBe(401);
  });

  it('CRON_SECRET 不一致は401', async () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret');
    const route = await load();
    const response = await route.GET(request('wrong-secret'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});
