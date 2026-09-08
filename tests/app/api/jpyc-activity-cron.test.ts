import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIVITY_NOW, activityWindow } from '../../helpers/jpycActivity';

const mocks = vi.hoisted(() => ({ get: vi.fn(), mget: vi.fn(), set: vi.fn(), lock: vi.fn(), getBlock: vi.fn(), getLogs: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/kv', () => ({ kvGet: mocks.get, kvMget: mocks.mget, kvSet: mocks.set, kvSetNxGet: mocks.lock }));
vi.mock('@/lib/logger', () => ({ logger: { warn: mocks.warn } }));
vi.mock('viem', async () => ({
  ...await vi.importActual<typeof import('viem')>('viem'),
  createPublicClient: () => ({ getBlock: mocks.getBlock, getLogs: mocks.getLogs }),
}));

let GET: (request: Request) => Promise<Response>;
const request = (secret = 'cron-test') => new Request('https://open-pay.jp/api/cron/jpyc-activity', {
  headers: { authorization: 'Bearer ' + secret },
});
const bucketWrites = () => mocks.set.mock.calls.filter(([key]) => key.includes(':b:'));
const newestWrites = () => mocks.set.mock.calls.filter(([key]) => key === 'jpyc:activity:polygon:newest');

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.resetModules();
  vi.resetAllMocks();
  ({ GET } = await import('@/app/api/cron/jpyc-activity/route'));
  vi.useFakeTimers();
  vi.setSystemTime(ACTIVITY_NOW);
  mocks.lock.mockResolvedValue({ ok: true, value: null });
  mocks.mget.mockResolvedValue({ ok: true, value: Array(25).fill(null) });
  mocks.set.mockResolvedValue({ ok: true, value: 'OK' });
  mocks.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => ({
    number: blockTag ? 181_800n : blockNumber,
    timestamp: BigInt(ACTIVITY_NOW / 1_000) + (blockNumber ?? 0n),
  }));
  mocks.getLogs.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('activity cron', () => {
  it('401 は KV / RPC 不呼出', async () => {
    expect((await GET(request('wrong'))).status).toBe(401);
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.getBlock).not.toHaveBeenCalled();
  });

  it('lock ok:false は503 storage_error、既存値は200 locked', async () => {
    mocks.lock.mockResolvedValueOnce({ ok: false, reason: 'unconfigured' });
    const failed = await GET(request());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'storage_error' });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    mocks.lock.mockResolvedValueOnce({ ok: true, value: 'owner' });
    const locked = await GET(request());
    expect(locked.status).toBe(200);
    expect(await locked.json()).toEqual({ skipped: 'locked' });
    expect(mocks.mget).not.toHaveBeenCalled();
    expect(mocks.getBlock).not.toHaveBeenCalled();
  });

  it('null lock は取得・55s lease、欠け0なら200・バケットは上書きしない', async () => {
    mocks.mget.mockResolvedValue({ ok: true, value: activityWindow().map((b) => JSON.stringify(b)) });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: '2026-09-08T03', finalized: '181800', newest: 100, written: [], missing: [], elapsedMs: 0 });
    expect(mocks.lock).toHaveBeenCalledWith('jpyc:activity:polygon:lock', expect.any(String), 55);
    expect(mocks.mget).toHaveBeenCalledWith(Array.from({ length: 25 }, (_, i) => 'jpyc:activity:polygon:b:' + (76 + i)));
    expect(bucketWrites()).toEqual([]);
    expect(newestWrites()).toEqual([['jpyc:activity:polygon:newest', '100', { ttlSec: 108_000 }]]);
    expect(mocks.getLogs).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('finalized 非対応で503・latestへ fallback しない・URLを衛生化', async () => {
    mocks.getBlock.mockRejectedValue(new Error('https://rpc.test/v2/secret token=abc'));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'scan_incomplete' });
    expect(mocks.getBlock.mock.calls).toEqual([[{ blockTag: 'finalized' }]]);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][1].reason).toBe('https://rpc.test/[redacted] token=[redacted]');
  });

  it('bootstrap は古い順に6件まで独立保存・進捗ありは200 complete:false', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toEqual([76, 77, 78, 79, 80, 81]);
    expect(body.missing).toEqual(Array.from({ length: 19 }, (_, i) => 82 + i));
    expect(body.complete).toBe(false);
    expect(bucketWrites()).toHaveLength(6);
    expect(newestWrites()).toEqual([]);
    for (const [key, value, opts] of bucketWrites()) {
      expect(key).toBe('jpyc:activity:polygon:b:' + JSON.parse(value).index);
      expect(opts).toEqual({ ttlSec: 108_000 });
    }
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it('進捗なし欠け残は503・失敗も6件上限・warnはrunで1回', async () => {
    mocks.getLogs.mockRejectedValue(new Error('RPC unavailable'));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'scan_incomplete' });
    expect(bucketWrites()).toHaveLength(0);
    expect(newestWrites()).toEqual([]);
    expect(mocks.getLogs).toHaveBeenCalledTimes(6 * 4);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][1].failedBuckets).toEqual([76, 77, 78, 79, 80, 81]);
  });

  it('1チャンク失敗のバケットは未書込、次runで同じキーを修復できる', async () => {
    const values: (string | null)[] = activityWindow().map((b) => JSON.stringify(b));
    values[0] = null;
    mocks.mget.mockResolvedValue({ ok: true, value: values });
    mocks.getLogs.mockRejectedValueOnce(new Error('one chunk failed'));
    expect((await GET(request())).status).toBe(503);
    expect(bucketWrites()).toHaveLength(0);
    expect(newestWrites()).toEqual([]);
    const repaired = await GET(request());
    expect(repaired.status).toBe(200);
    expect((await repaired.json()).missing).toEqual([]);
    expect(bucketWrites()).toHaveLength(1);
    expect(newestWrites()).toEqual([['jpyc:activity:polygon:newest', '100', { ttlSec: 108_000 }]]);
    expect(mocks.set.mock.calls.map(([key]) => key)).toEqual([
      'jpyc:activity:polygon:b:76', 'jpyc:activity:polygon:newest',
    ]);
  });

  it('N=P+1 の走査失敗は503でも pointer P と既存の完全かつ新鮮な窓を保つ', async () => {
    const newestKey = 'jpyc:activity:polygon:newest';
    const stored = new Map(activityWindow().map((b) => ['jpyc:activity:polygon:b:' + b.index, JSON.stringify(b)]));
    stored.set(newestKey, '100');
    vi.setSystemTime(ACTIVITY_NOW + 3_600_000);
    mocks.get.mockImplementation(async (key: string) => ({ ok: true, value: stored.get(key) ?? null }));
    mocks.mget.mockImplementation(async (keys: string[]) => ({ ok: true, value: keys.map((key) => stored.get(key) ?? null) }));
    mocks.set.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
      return { ok: true, value: 'OK' };
    });
    mocks.getBlock.mockResolvedValueOnce({ number: 183_600n, timestamp: BigInt(Date.now() / 1_000) });
    mocks.getLogs.mockRejectedValue(new Error('newest bucket scan failed'));

    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'scan_incomplete' });
    expect(mocks.mget).toHaveBeenCalledWith(Array.from({ length: 25 }, (_, i) => 'jpyc:activity:polygon:b:' + (77 + i)));
    expect(mocks.warn.mock.calls[0][1]).toMatchObject({ written: [], missing: [101], failedBuckets: [101] });
    expect(newestWrites()).toEqual([]);
    expect(stored.get(newestKey)).toBe('100');
    expect(stored.has('jpyc:activity:polygon:b:101')).toBe(false);

    const { readActivityWindow } = await import('@/lib/jpyc/activity');
    expect(await readActivityWindow()).toMatchObject({
      ok: true, aggregate: { observedAt: new Date(ACTIVITY_NOW).toISOString(), transferCount: 24 },
    });
  });

  it('35秒ちょうどから新規dispatch停止、進行中のバケットは保存', async () => {
    mocks.getBlock.mockImplementation(({ blockTag, blockNumber }) => {
      if (blockTag) return Promise.resolve({ number: 181_800n, timestamp: BigInt(ACTIVITY_NOW / 1_000) });
      return new Promise((resolve) => setTimeout(() => resolve({ number: blockNumber,
        timestamp: BigInt(ACTIVITY_NOW / 1_000) + blockNumber }), 17_500));
    });
    const run = GET(request());
    await vi.advanceTimersByTimeAsync(35_000);
    const res = await run;
    expect(res.status).toBe(200);
    expect((await res.json()).written).toEqual([76, 77]);
    expect(bucketWrites()).toHaveLength(2);
    expect(newestWrites()).toEqual([]);
  });

  it('finalized timeout は5秒で503', async () => {
    mocks.getBlock.mockImplementation(() => new Promise(() => {}));
    const run = GET(request());
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await run).status).toBe(503);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it.each(['mget', 'head', 'bucket'])('%s の保存障害は503 storage_error', async (stage) => {
    if (stage === 'mget') mocks.mget.mockResolvedValue({ ok: false, reason: 'timeout' });
    else {
      if (stage === 'head') mocks.mget.mockResolvedValue({ ok: true, value: activityWindow().map((b) => JSON.stringify(b)) });
      mocks.set.mockResolvedValue({ ok: false, reason: 'http_error' });
    }
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'storage_error' });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    if (stage === 'head') expect(newestWrites()).toHaveLength(1);
    else expect(newestWrites()).toEqual([]);
    if (stage === 'bucket') expect(bucketWrites()).toHaveLength(1);
  });

  it('workflow は毎時20分・手動復旧・同じcron secret', () => {
    const workflow = readFileSync('.github/workflows/jpyc-activity-cron.yml', 'utf8');
    expect(workflow).toContain("cron: '20 * * * *'");
    expect(workflow).toContain('workflow_dispatch: {}');
    expect(workflow).toContain('secrets.CRON_SECRET');
    expect(workflow).toContain('https://open-pay.jp/api/cron/jpyc-activity');
  });
});
