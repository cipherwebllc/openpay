import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReverifyCursor } from '@/lib/x402/reverify';

// 本番設定の検証 (scripts/verify-production-config.mjs) が読む、再検証の最後の成功の確認口。
// cursor を読むだけで、再検証そのもの (lock・probe・cursor の書き込み) は動かさない。
const io = vi.hoisted(() => ({
  cursor: { offset: 0 } as ReverifyCursor | null,
  reads: 0,
}));

vi.mock('@/lib/x402/reverify', () => ({
  readReverifyCursor: async () => {
    io.reads += 1;
    return io.cursor;
  },
}));

let GET: (request: Request) => Promise<Response>;
const request = (authorization?: string) => new Request('https://open-pay.jp/api/cron/reverify-status', {
  headers: authorization ? { authorization } : {},
});

beforeEach(async () => {
  io.cursor = { offset: 0 };
  io.reads = 0;
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.resetModules();
  ({ GET } = await import('@/app/api/cron/reverify-status/route'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/cron/reverify-status', () => {
  it('秘密が一致すれば lastOkAt だけを返す (offset 等の内部状態は出さない・キャッシュさせない)', async () => {
    io.cursor = { offset: 7, storageErrorStreak: 1, directoryDate: '2026-10-30', lastOkAt: '2026-10-30T02:00:00.000Z' };
    const res = await GET(request('Bearer cron-test'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ lastOkAt: '2026-10-30T02:00:00.000Z' });
  });

  it('まだ 1 度も正常な batch が無ければ null', async () => {
    const res = await GET(request('Bearer cron-test'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lastOkAt: null });
  });

  it('KV が読めなければ 503 (記録なしと区別する)', async () => {
    io.cursor = null;
    const res = await GET(request('Bearer cron-test'));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'storage_unavailable' });
  });

  it('秘密が無い・違うなら 401 で KV を読まない', async () => {
    for (const authorization of [undefined, 'Bearer wrong', 'cron-test']) {
      const res = await GET(request(authorization));
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(io.reads).toBe(0);
  });

  it('CRON_SECRET が未設定なら、どの header でも 401 (fail-closed)', async () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.resetModules();
    ({ GET } = await import('@/app/api/cron/reverify-status/route'));
    for (const authorization of [undefined, 'Bearer ', 'Bearer cron-test']) {
      expect((await GET(request(authorization))).status).toBe(401);
    }
    expect(io.reads).toBe(0);
  });
});
