import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '@/app/api/market/rates/route';

// fetch を global で hijack して CoinGecko 応答を制御する。実 network には出ない。

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/market/rates: GET', () => {
  it('CoinGecko が 200 + 正常 shape を返す → { usdcJpy, updatedAt } JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'usd-coin': { jpy: 154.5 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.usdcJpy).toBe(154.5);
    expect(typeof body.updatedAt).toBe('string');
    // ISO 8601
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('CoinGecko が 5xx → 502 { error: "upstream" }', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('upstream');
    expect(body.status).toBe(429);
  });

  it('CoinGecko が 200 だが shape 不正 (jpy field 欠落) → 502 invalid-shape', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'usd-coin': {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('invalid-shape');
  });

  it('CoinGecko が 200 だが usdc jpy が文字列 → 502 invalid-shape', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'usd-coin': { jpy: 'not-a-number' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('invalid-shape');
  });

  it('CoinGecko が 200 だが usdc jpy が 0 (sentinel) → 502 invalid-shape', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'usd-coin': { jpy: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it('User-Agent ヘッダ + Next revalidate オプションが付いて fetch される', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'usd-coin': { jpy: 150 } }), { status: 200 }),
    );
    await GET();
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain('api.coingecko.com');
    expect(call[0]).toContain('usd-coin');
    expect(call[0]).toContain('vs_currencies=jpy');
    const opts = call[1] as { headers?: Record<string, string>; next?: { revalidate?: number } };
    expect(opts.headers?.['User-Agent']).toContain('OpenPay');
    expect(opts.next?.revalidate).toBe(300);
  });
});
