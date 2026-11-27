import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

// AI エージェント向けの読み取りと発見を、本番 build に HTTP で通して確かめる (2026-11-27)。
// vitest は middleware の matcher も route の選ばれ方も通らないので、配線の回帰はここで捕まえる
// (例: matcher から / が外れる・未知の /api に別の route が選ばれる・Vary や Link が落ちる)。

test.describe('AI エージェント向けの読み取りと発見', () => {
  for (const path of ['/', '/ja', '/en']) {
    test(`${path} を Accept: text/markdown で求めると llms.txt と同じ Markdown`, async ({ request }) => {
      const res = await request.get(path, {
        headers: { Accept: 'text/markdown' },
        maxRedirects: 0,
      });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('text/markdown; charset=utf-8');
      // 部分一致だと Accept-Encoding でも通るので、要素ごとに比べる。
      const vary = (res.headers()['vary'] ?? '').split(',').map((v) => v.trim().toLowerCase());
      expect(vary).toContain('accept');
      const llms = await (await request.get('/llms.txt')).text();
      expect(await res.text()).toBe(llms);
    });
  }

  test('ブラウザの Accept の /ja は HTML のまま', async ({ request }) => {
    const res = await request.get('/ja', {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
  });

  for (const [method, path] of [
    ['GET', '/api'],
    ['GET', '/api/does-not-exist'],
    ['POST', '/api/a/b/c'],
    ['OPTIONS', '/api/does-not-exist'],
  ] as const) {
    test(`${method} ${path} は problem+json の 404`, async ({ request }) => {
      const res = await request.fetch(path, { method });
      expect(res.status()).toBe(404);
      expect(res.headers()['content-type']).toBe('application/problem+json; charset=utf-8');
      expect((await res.json()).error).toBe('not_found');
    });
  }

  test('今ある API は catch-all に取られない (/api/paid/hello は 402)', async ({ request }) => {
    const res = await request.get('/api/paid/hello');
    expect(res.status()).toBe(402);
  });

  for (const method of ['GET', 'HEAD'] as const) {
    test(`${method} /.well-known/api-catalog は linkset+json と rel="api-catalog" の Link`, async ({ request }) => {
      const res = await request.fetch('/.well-known/api-catalog', { method });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toBe('application/linkset+json');
      expect(res.headers()['link']).toBe('</.well-known/api-catalog>; rel="api-catalog"');
    });
  }

  test('agent-skills の目録の digest は配る SKILL.md の sha256', async ({ request }) => {
    const index = await (await request.get('/.well-known/agent-skills/index.json')).json();
    const [skill] = index.skills;
    const skillRes = await request.get(skill.url);
    expect(skillRes.status()).toBe(200);
    expect(skillRes.headers()['content-type']).toBe('text/markdown; charset=utf-8');
    const digest = createHash('sha256').update(await skillRes.body()).digest('hex');
    expect(skill.digest).toBe(`sha256:${digest}`);
  });
});
