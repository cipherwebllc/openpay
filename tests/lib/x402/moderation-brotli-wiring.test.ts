// @vitest-environment node
// fetchSsrfSafe の既定の取得 (fetchImpl を渡さない本番の経路) が、br の応答を止める仕組みを通ることを確かめる。
// 本物の接続は private IP を拒むのでローカルのサーバに届かない → undici の fetch を差し替えて組み立てだけを見る。
import { Agent } from 'undici';
import { describe, expect, it, vi } from 'vitest';

const dispatchers: unknown[] = [];

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: async (_url: string, init: { dispatcher?: unknown }) => {
    dispatchers.push(init.dispatcher);
    return new Response(null, { status: 204 });
  },
}));

describe('lib/x402/moderation fetchSsrfSafe の既定の取得', () => {
  it('SSRF-safe Agent に refuseBrotliResponses を組み込んだ dispatcher で fetch する', async () => {
    const compose = vi.spyOn(Agent.prototype, 'compose');
    const { fetchSsrfSafe, refuseBrotliResponses } = await import('@/lib/x402/moderation');
    const res = await fetchSsrfSafe('https://seller.example/paid', {
      lookup: async () => [{ address: '93.184.216.34' }],
    });

    expect(res?.status).toBe(204);
    expect(compose.mock.calls).toEqual([[refuseBrotliResponses]]);
    expect(dispatchers).toHaveLength(1);
    expect(dispatchers[0]).toBe(compose.mock.results[0].value);
  });
});
