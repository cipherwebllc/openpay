import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIVITY_NOW, activityWindow, bucket } from '../../helpers/jpycActivity';

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
const attemptedBuckets = () => mocks.getBlock.mock.calls
  .filter(([args]) => args.blockNumber !== undefined && args.blockNumber % 1_800n === 0n)
  .map(([args]) => Number(args.blockNumber / 1_800n));
function blockHeader(blockNumber: bigint, blockTimeSeconds = 2) {
  const index = Number(blockNumber / 1_800n);
  const row = bucket(index, [], ACTIVITY_NOW - (100 - index) * 1_800 * blockTimeSeconds * 1_000, blockTimeSeconds);
  return { number: blockNumber, timestamp: BigInt(Math.floor(Date.parse(blockNumber % 1_800n === 0n ? row.fromTimestamp : row.toTimestamp) / 1_000)) };
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.resetModules();
  vi.resetAllMocks();
  ({ GET } = await import('@/app/api/cron/jpyc-activity/route'));
  vi.useFakeTimers();
  vi.setSystemTime(ACTIVITY_NOW);
  mocks.lock.mockResolvedValue({ ok: true, value: null });
  mocks.mget.mockResolvedValue({ ok: true, value: Array(60).fill(null) });
  mocks.set.mockResolvedValue({ ok: true, value: 'OK' });
  mocks.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => blockTag
    ? { number: 181_800n, timestamp: BigInt(ACTIVITY_NOW / 1_000) } : blockHeader(blockNumber));
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
    expect(await res.json()).toEqual({ runId: '2026-09-08T03', finalized: '181800', newest: 100, boundary: 76, written: [], missing: [], elapsedMs: 0 });
    expect(mocks.lock).toHaveBeenCalledWith('jpyc:activity:polygon:lock', expect.any(String), 55);
    expect(mocks.mget).toHaveBeenCalledOnce();
    expect(mocks.mget).toHaveBeenCalledWith(Array.from({ length: 60 }, (_, i) => 'jpyc:activity:polygon:b:' + (41 + i)));
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

  it('bootstrap は N を最初に新しい順に12件まで独立保存・進捗ありは200 complete:false', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toEqual(Array.from({ length: 12 }, (_, i) => 100 - i));
    expect(attemptedBuckets()).toEqual(body.written);
    expect(body.boundary).toBeNull();
    expect(body.missing).toEqual([88]);
    expect(body.complete).toBe(false);
    expect(bucketWrites()).toHaveLength(12);
    expect(newestWrites()).toEqual([]);
    for (const [key, value, opts] of bucketWrites()) {
      expect(key).toBe('jpyc:activity:polygon:b:' + JSON.parse(value).index);
      expect(opts).toEqual({ ttlSec: 108_000 });
    }
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it('N の走査失敗は T 不明のまま過去へ進まず503・warnはrunで1回', async () => {
    mocks.getLogs.mockRejectedValue(new Error('RPC unavailable'));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'scan_incomplete' });
    expect(bucketWrites()).toHaveLength(0);
    expect(newestWrites()).toEqual([]);
    expect(attemptedBuckets()).toEqual([100]);
    expect(mocks.getLogs).toHaveBeenCalledTimes(4);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][1]).toMatchObject({ failedBuckets: [100], missing: [100] });
  });

  it('N が保存済みでも失敗12件で予算を使い切る・進捗なしは503', async () => {
    const values = Array(60).fill(null);
    values[59] = JSON.stringify(bucket());
    mocks.mget.mockResolvedValue({ ok: true, value: values });
    mocks.getLogs.mockRejectedValue(new Error('RPC unavailable'));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'scan_incomplete' });
    const failed = Array.from({ length: 12 }, (_, i) => 99 - i);
    expect(attemptedBuckets()).toEqual(failed);
    expect(mocks.getLogs).toHaveBeenCalledTimes(12 * 4);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][1]).toMatchObject({ failedBuckets: failed, missing: [...failed, 87] });
  });

  it('成功と失敗を合わせて12件まで・失敗バケットの部分データは保存しない', async () => {
    const values = Array(60).fill(null);
    values[59] = JSON.stringify(bucket());
    mocks.mget.mockResolvedValue({ ok: true, value: values });
    const failed = [99, 95, 90];
    mocks.getLogs.mockImplementation(async ({ fromBlock }) => {
      if (failed.includes(Number(fromBlock / 1_800n))) throw new Error('chunk failed');
      return [];
    });
    const res = await GET(request());
    expect(res.status).toBe(200);
    const attempted = Array.from({ length: 12 }, (_, i) => 99 - i);
    expect(attemptedBuckets()).toEqual(attempted);
    expect(await res.json()).toMatchObject({ boundary: null, complete: false,
      written: attempted.filter((i) => !failed.includes(i)), missing: [...failed, 87] });
    expect(bucketWrites()).toHaveLength(9);
    expect(newestWrites()).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it('1チャンク失敗のバケットは未書込、次runで同じキーを修復できる', async () => {
    const values: (string | null)[] = activityWindow().map((b) => JSON.stringify(b));
    values[49] = null;
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
      'jpyc:activity:polygon:b:90', 'jpyc:activity:polygon:newest',
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
    expect(mocks.mget).toHaveBeenCalledWith(Array.from({ length: 60 }, (_, i) => 'jpyc:activity:polygon:b:' + (42 + i)));
    expect(mocks.warn.mock.calls[0][1]).toMatchObject({ written: [], missing: [101], failedBuckets: [101] });
    expect(newestWrites()).toEqual([]);
    expect(stored.get(newestKey)).toBe('100');
    expect(stored.has('jpyc:activity:polygon:b:101')).toBe(false);

    const { readActivityWindow } = await import('@/lib/jpyc/activity');
    expect(await readActivityWindow()).toMatchObject({
      ok: true, aggregate: { observedAt: new Date(ACTIVITY_NOW).toISOString(), transferCount: 25 },
    });
  });

  it('N 自体の欠落を最初に走査して T を得てから、古い欠けを新しい順に埋める', async () => {
    const rows = activityWindow();
    const gaps = [100, 98, 90, 76];
    mocks.mget.mockResolvedValue({ ok: true, value: rows.map((b) => gaps.includes(b.index) || b.index < 76 ? null : JSON.stringify(b)) });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boundary: 76, written: gaps, missing: [] });
    expect(attemptedBuckets()).toEqual(gaps);
    expect(mocks.mget.mock.invocationCallOrder[0]).toBeLessThan(mocks.getBlock.mock.invocationCallOrder[1]);
    expect(mocks.set.mock.calls.map(([key]) => key)).toEqual([
      ...gaps.map((i) => 'jpyc:activity:polygon:b:' + i), 'jpyc:activity:polygon:newest',
    ]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each([1, 1.5, 2, 3])('%ss/block: 境界の等号で停止し、範囲外の欠落・破損を missing に含めない', async (blockTimeSeconds) => {
    const rows = activityWindow(ACTIVITY_NOW, blockTimeSeconds);
    const boundary = 101 - 86_400 / (1_800 * blockTimeSeconds);
    rows.find((b) => b.index === boundary)!.fromTimestamp = new Date(ACTIVITY_NOW - 86_400_000).toISOString();
    expect(rows.find((b) => b.index === boundary)!.fromTimestamp).toBe(new Date(ACTIVITY_NOW - 86_400_000).toISOString());
    mocks.mget.mockResolvedValue({ ok: true, value: rows.map((b) => b.index < boundary ? (b.index % 2 ? null : '{') : JSON.stringify(b)) });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boundary, missing: [], written: [] });
    expect(mocks.getLogs).not.toHaveBeenCalled();
    expect(newestWrites()).toEqual([['jpyc:activity:polygon:newest', '100', { ttlSec: 108_000 }]]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('境界に達しても途中の失敗が残る間は pointer を公開しない', async () => {
    const values = activityWindow().map((b) => [95, 90].includes(b.index) ? null : JSON.stringify(b));
    mocks.mget.mockResolvedValue({ ok: true, value: values });
    mocks.getLogs.mockRejectedValueOnce(new Error('one chunk failed'));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boundary: 76, complete: false, written: [90], missing: [95] });
    expect(attemptedBuckets()).toEqual([95, 90]);
    expect(newestWrites()).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it('1.5s/block の bootstrap は run を跨いで再開し、[M,N] 完成時だけ公開', async () => {
    const stored = new Map<string, string>();
    mocks.mget.mockImplementation(async (keys: string[]) => ({ ok: true, value: keys.map((key) => stored.get(key) ?? null) }));
    mocks.set.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value);
      return { ok: true, value: 'OK' };
    });
    mocks.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => blockTag
      ? { number: 181_800n, timestamp: BigInt(ACTIVITY_NOW / 1_000) } : blockHeader(blockNumber, 1.5));
    for (const [run, count] of [12, 12, 9].entries()) {
      const res = await GET(request());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.written).toEqual(Array.from({ length: count }, (_, i) => 100 - run * 12 - i));
      expect(body.boundary).toBe(run < 2 ? null : 68);
      if (run < 2) {
        expect(body.complete).toBe(false);
        expect(newestWrites()).toEqual([]);
        expect(stored.has('jpyc:activity:polygon:newest')).toBe(false);
      } else {
        expect(body.missing).toEqual([]);
        expect(body).not.toHaveProperty('complete');
        expect(newestWrites()).toHaveLength(1);
        expect(stored.get('jpyc:activity:polygon:newest')).toBe('100');
      }
    }
    expect(attemptedBuckets()).toEqual(Array.from({ length: 33 }, (_, i) => 100 - i));
    expect(mocks.warn).toHaveBeenCalledTimes(2);
  });

  it.each([0.81, 0.5])('%ss/block: 60件目までに境界が必要・lookback 外へ追加走査しない', async (blockTimeSeconds) => {
    mocks.mget.mockResolvedValue({ ok: true, value: activityWindow(ACTIVITY_NOW, blockTimeSeconds).map((b) => JSON.stringify(b)) });
    const res = await GET(request());
    if (blockTimeSeconds === 0.81) {
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ boundary: 41, written: [], missing: [] });
      expect(newestWrites()).toHaveLength(1);
    } else {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'scan_incomplete' });
      expect(mocks.set).not.toHaveBeenCalled();
      expect(mocks.warn).toHaveBeenCalledTimes(1);
      expect(mocks.warn.mock.calls[0][1].missing).toEqual([]);
    }
    expect(mocks.mget).toHaveBeenCalledOnce();
    expect(mocks.mget).toHaveBeenCalledWith(Array.from({ length: 60 }, (_, i) => 'jpyc:activity:polygon:b:' + (41 + i)));
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });

  it.each(['overflow', 'reversed'])('%s の保存済み範囲は完全と見なさず pointer を公開しない', async (kind) => {
    const rows = activityWindow();
    if (kind === 'overflow') Object.assign(rows[48], { overflow: true, items: [], eventCount: 5_001 });
    else rows[48].fromTimestamp = rows[47].fromTimestamp;
    mocks.mget.mockResolvedValue({ ok: true, value: rows.map((b) => JSON.stringify(b)) });
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'scan_incomplete' });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][1].missing).toEqual([]);
  });

  it('60件目を書けても T-24h に届かなければ boundary:null・complete:false・pointer 不変', async () => {
    const rows = activityWindow(ACTIVITY_NOW, 0.5);
    mocks.mget.mockResolvedValue({ ok: true, value: rows.map((b, i) => i === 0 ? null : JSON.stringify(b)) });
    mocks.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => blockTag
      ? { number: 181_800n, timestamp: BigInt(ACTIVITY_NOW / 1_000) } : blockHeader(blockNumber, 0.5));
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boundary: null, complete: false, written: [41], missing: [] });
    expect(attemptedBuckets()).toEqual([41]);
    expect(newestWrites()).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it('35秒ちょうどから新規dispatch停止、進行中のバケットは保存', async () => {
    mocks.getBlock.mockImplementation(({ blockTag, blockNumber }) => {
      if (blockTag) return Promise.resolve({ number: 181_800n, timestamp: BigInt(ACTIVITY_NOW / 1_000) });
      return new Promise((resolve) => setTimeout(() => resolve(blockHeader(blockNumber)), 17_500));
    });
    const run = GET(request());
    await vi.advanceTimersByTimeAsync(35_000);
    const res = await run;
    expect(res.status).toBe(200);
    expect((await res.json()).written).toEqual([100, 99]);
    expect(attemptedBuckets()).toEqual([100, 99]);
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
