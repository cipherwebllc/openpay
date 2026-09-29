import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// fetch を global で hijack して取得元 (Coinbase) の応答を制御する。実 network には出ない。
// logger は境界 mock — Sentry 連動を含む実 logger を呼ばず、502 path で
// "market.rates.upstream_error" event が正しく発行されることを検証する。
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET } from '@/app/api/market/rates/route';
import { logger } from '@/lib/logger';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(logger.warn).mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/market/rates: GET', () => {
  it('取得元が 200 + 正常 shape を返す → { usdcJpy, updatedAt } JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { currency: 'USDC', rates: { JPY: String(154.5) } } }), {
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

  it('取得元が 5xx → 502 { error: "upstream" } + logger.warn 発行', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('upstream');
    expect(body.status).toBe(429);
    expect(logger.warn).toHaveBeenCalledWith('market.rates.upstream_error', {
      reason: 'non-ok',
      status: 429,
    });
  });

  it('取得元が 200 だが shape 不正 (jpy field 欠落) → 502 invalid-shape + logger.warn', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { currency: 'USDC', rates: {} } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('invalid-shape');
    expect(logger.warn).toHaveBeenCalledWith('market.rates.upstream_error', {
      reason: 'invalid-shape',
    });
  });

  it('取得元が 200 だが JPY が数値でない文字列 → 502 invalid-shape', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { currency: 'USDC', rates: { JPY: 'not-a-number' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('invalid-shape');
  });

  it('取得元が 200 だが JPY が 0 (sentinel) → 502 invalid-shape', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { currency: 'USDC', rates: { JPY: String(0) } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it('usdcJpy が band 下限未満 (40) → 502 out-of-band + logger.warn (決済用 sanity guard)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { currency: 'USDC', rates: { JPY: String(40) } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('out-of-band');
    expect(logger.warn).toHaveBeenCalledWith('market.rates.upstream_error', {
      reason: 'out-of-band',
      usdcJpy: 40,
    });
  });

  it('usdcJpy が band 上限超 (600・単位ミス等) → 502 out-of-band (絶対額の誤焼込防止)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { currency: 'USDC', rates: { JPY: String(600) } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await GET();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('out-of-band');
  });

  it('band 境界内 (50 / 500) は 200 で通す', async () => {
    for (const jpy of [50, 500]) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { currency: 'USDC', rates: { JPY: String(jpy) } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const res = await GET();
      expect(res.status).toBe(200);
      expect((await res.json()).usdcJpy).toBe(jpy);
    }
  });

  it('User-Agent ヘッダ + Next revalidate オプションが付いて fetch される', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { currency: 'USDC', rates: { JPY: String(150) } } }), { status: 200 }),
    );
    await GET();
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://api.coinbase.com/v2/exchange-rates?currency=USDC');
    const opts = call[1] as { headers?: Record<string, string>; next?: { revalidate?: number } };
    expect(opts.headers?.['User-Agent']).toContain('OpenPay');
    expect(opts.next?.revalidate).toBe(300);
  });
});
