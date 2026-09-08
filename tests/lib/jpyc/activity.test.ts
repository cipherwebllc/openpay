import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_CONTRACT, ACTIVITY_NOW, RECEIVER, SENDER, activityWindow, bucket } from '../../helpers/jpycActivity';

const mocks = vi.hoisted(() => ({ get: vi.fn(), mget: vi.fn(), getBlock: vi.fn(), getLogs: vi.fn() }));
vi.mock('@/lib/kv', () => ({ kvGet: mocks.get, kvMget: mocks.mget }));
vi.mock('viem', async () => ({
  ...await vi.importActual<typeof import('viem')>('viem'),
  createPublicClient: () => ({ getBlock: mocks.getBlock, getLogs: mocks.getLogs }),
}));

type Activity = typeof import('@/lib/jpyc/activity');
let activity: Activity;
beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_NETWORK_ENV', 'mainnet');
  vi.resetModules();
  vi.resetAllMocks();
  activity = await import('@/lib/jpyc/activity');
  vi.useFakeTimers();
  vi.setSystemTime(ACTIVITY_NOW);
  mocks.get.mockResolvedValue({ ok: true, value: '100' });
  mocks.mget.mockResolvedValue({ ok: true, value: activityWindow().map((b) => JSON.stringify(b)) });
  mocks.getBlock.mockImplementation(async ({ blockNumber }) => ({
    number: blockNumber, timestamp: BigInt(ACTIVITY_NOW / 1_000) + blockNumber,
  }));
  mocks.getLogs.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('固定バケット・純粋集計', () => {
  it('1799 / 1800 境界と必要集合は [N-24,N]', () => {
    expect(activity.newestActivityBucket(1_799n)).toBe(-1);
    expect(activity.newestActivityBucket(1_800n)).toBe(0);
    expect(activity.activityBucketRange(1)).toEqual({ fromBlock: 1_800n, toBlock: 3_599n });
    expect(activity.requiredActivityBuckets(100)).toEqual(Array.from({ length: 25 }, (_, i) => 76 + i));
    expect(activity.activityBucketKey(100)).toBe('jpyc:activity:polygon:b:100');
  });

  it('窓の下端は toTimestamp > T-86400 (ちょうどは除外)', () => {
    const rows = activityWindow();
    const result = activity.aggregateActivity(rows);
    expect(result.transferCount).toBe(24);
    expect(result.fromBlock).toBe(rows[1].fromBlock);
    rows[0].toTimestamp = new Date(ACTIVITY_NOW - 86_400_000 + 1).toISOString();
    expect(activity.aggregateActivity(rows).transferCount).toBe(25);
    expect(activity.aggregateActivity([...rows].reverse())).toEqual(activity.aggregateActivity(rows));
  });

  it('0 値 / 自己送金 / zero は除外し、コントラクトは含む', () => {
    const zero = '0x' + '0'.repeat(40);
    for (const [from, to, value] of [[SENDER, RECEIVER, 0n], [SENDER, SENDER.toUpperCase(), 1n], [zero, RECEIVER, 1n], [SENDER, zero, 1n]] as const) {
      expect(activity.eligibleActivityTransfer(from, to, value)).toBe(false);
    }
    expect(activity.eligibleActivityTransfer(SENDER, ACTIVITY_CONTRACT, 1n)).toBe(true);
    const result = activity.aggregateActivity([bucket(100, [[SENDER, RECEIVER, '0'], [SENDER, ACTIVITY_CONTRACT, '1']])]);
    expect(result.transferCount).toBe(1);
    expect(result.topReceivers[0].address).toBe(ACTIVITY_CONTRACT.toLowerCase());
  });

  it.each([
    [[], '0'], [['7'], '7'], [['1', '2'], '1'], [['7', '1', '4'], '4'],
    [['1', '8', '2', '5'], '3'],
  ])('median %j は %s (偶数は atomic 切捨て)', (values, median) => {
    const result = activity.aggregateActivity([bucket(100, values.map((value) => [SENDER, RECEIVER, value]))]);
    expect(result.medianTransfer).toBe(median);
    if (values.length === 0) {
      expect(result.topReceivers).toEqual([]);
      expect(result.volume).toBe('0');
      expect(result.uniqueSenders).toBe(0);
      expect(result.uniqueReceivers).toBe(0);
    }
  });

  it('巨大な金額は BigInt 和・median・volume tie 順を保つ', () => {
    const large = 10n ** 70n;
    const result = activity.aggregateActivity([bucket(100, [
      [SENDER, RECEIVER, String(large)], [SENDER, RECEIVER, String(large + 1n)],
    ])]);
    expect(result.volume).toBe(String(2n * large + 1n));
    expect(result.medianTransfer).toBe(String(large));
    expect(result.topReceivers[0].volume).toBe(result.volume);
    const higher = '0x' + 'c'.repeat(40);
    const tiedCounts = activity.aggregateActivity([bucket(100, [
      [SENDER, RECEIVER, String(large)], [SENDER, higher, String(large + 1n)],
    ])]);
    expect(tiedCounts.topReceivers.map((r) => r.address)).toEqual([higher, RECEIVER]);
  });

  it('受信者は count desc → volume desc → address asc、小文字、最大5、paddingなし', () => {
    const a = '0x' + 'a'.repeat(40);
    const b = '0x' + 'b'.repeat(40);
    const c = '0x' + 'c'.repeat(40);
    const rows = bucket(100, [[SENDER, a, '1'], [SENDER, a.toUpperCase(), '1'],
      [SENDER, b, '5'], [SENDER, c, '5']]);
    expect(activity.aggregateActivity([rows]).topReceivers.map((r) => r.address)).toEqual([a, b, c]);
    rows.items.push([SENDER, '0x' + 'd'.repeat(40), '6']);
    expect(activity.aggregateActivity([rows]).topReceivers[1].volume).toBe('6');
    rows.items.push([SENDER, '0x' + 'e'.repeat(40), '1'], [SENDER, '0x' + 'f'.repeat(40), '1']);
    expect(activity.aggregateActivity([rows]).topReceivers).toHaveLength(5);
    expect(activity.aggregateActivity([bucket(100, rows.items.slice(2, 4))]).topReceivers).toHaveLength(2);
  });

  it('鮮度は4hちょうど可、+1msは stale、未来60sちょうど可', () => {
    const iso = (offset: number) => new Date(ACTIVITY_NOW + offset).toISOString();
    expect(activity.activityFreshness(iso(-14_400_000))).toBeNull();
    expect(activity.activityFreshness(iso(-14_400_001))).toBe('data_stale');
    expect(activity.activityFreshness(iso(60_000))).toBeNull();
    expect(activity.activityFreshness(iso(60_001))).toBe('data_unavailable');
    expect(activity.activityFreshness('invalid')).toBe('data_unavailable');
  });
});

describe('バケット検証と共有 reader', () => {
  it('schema / ISO / 数字列 / 範囲 / address / overflow の不正を拒否', () => {
    expect(activity.validActivityBucket(bucket(), 100)).toBe(true);
    for (const fields of [
      { schema: 2 }, { chainId: 80002 }, { chain: 'kaia' }, { index: 99 }, { contract: RECEIVER },
      { fromTimestamp: 'NaN' }, { toTimestamp: '2026-02-30T00:00:00.000Z' },
      { toTimestamp: '2026-09-08' }, { toTimestamp: bucket().fromTimestamp.slice(0, 10) },
      { fromBlock: '-1' }, { toBlock: '1e9' }, { fromBlock: '180001' },
      { eventCount: -1 }, { eventCount: 0.5 }, { items: [[SENDER, RECEIVER, '1e18']] },
      { items: [[SENDER, '0x12', '1']] }, { overflow: true },
    ]) expect(activity.validActivityBucket({ ...bucket(), ...fields }, 100), JSON.stringify(fields)).toBe(false);
    expect(activity.parseActivityBucket('{', 100)).toBeNull();
    expect(activity.parseActivityBucket('null', 100)).toBeNull();
  });

  it('正常窓は GET + 25-key MGET、observedAt は保存 timestamp のまま', async () => {
    const result = await activity.readActivityWindow();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.aggregate.observedAt).toBe(new Date(ACTIVITY_NOW).toISOString());
      expect(result.aggregate.transferCount).toBe(24);
    }
    expect(mocks.mget).toHaveBeenCalledWith(activity.requiredActivityBuckets(100).map(activity.activityBucketKey));
    expect(mocks.getBlock).not.toHaveBeenCalled();
  });

  it('pointer P の完全窓 [P-24,P] は P+1 が未保存でも読める', async () => {
    const stored = new Map(activityWindow().map((b) => [activity.activityBucketKey(b.index), JSON.stringify(b)]));
    stored.set(activity.ACTIVITY_NEWEST_KEY, '100');
    mocks.get.mockImplementation(async (key: string) => ({ ok: true, value: stored.get(key) ?? null }));
    mocks.mget.mockImplementation(async (keys: string[]) => ({ ok: true, value: keys.map((key) => stored.get(key) ?? null) }));
    vi.setSystemTime(ACTIVITY_NOW + 3_600_000);

    expect(stored.has(activity.activityBucketKey(101))).toBe(false);
    expect(await activity.readActivityWindow()).toMatchObject({
      ok: true, aggregate: { observedAt: new Date(ACTIVITY_NOW).toISOString(), transferCount: 24 },
    });
    expect(mocks.get).toHaveBeenCalledWith(activity.ACTIVITY_NEWEST_KEY);
    expect(mocks.mget).toHaveBeenCalledWith(activity.requiredActivityBuckets(100).map(activity.activityBucketKey));
    expect(mocks.getBlock).not.toHaveBeenCalled();
    expect(mocks.getLogs).not.toHaveBeenCalled();
  });

  it.each([0, 12, 24])('先頭・中間・末尾の欠落 (%s) は incomplete', async (offset) => {
    const values: (string | null)[] = activityWindow().map((b) => JSON.stringify(b));
    values[offset] = null;
    mocks.mget.mockResolvedValue({ ok: true, value: values });
    expect(await activity.readActivityWindow()).toEqual({ ok: false, reason: 'data_incomplete' });
  });

  it.each(['overflow', 'malformed', 'schema', 'stale', 'future', 'reversed'])('%s は販売不可', async (kind) => {
    const rows = activityWindow(kind === 'stale' ? ACTIVITY_NOW - 14_400_001 : kind === 'future' ? ACTIVITY_NOW + 60_001 : ACTIVITY_NOW);
    if (kind === 'overflow') Object.assign(rows[0], { items: [], overflow: true, eventCount: 5_001 });
    if (kind === 'schema') Object.assign(rows[0], { schema: 2 });
    if (kind === 'reversed') rows[1].fromTimestamp = rows[0].fromTimestamp;
    const raw = rows.map((b) => JSON.stringify(b));
    if (kind === 'malformed') raw[0] = '{';
    mocks.mget.mockResolvedValue({ ok: true, value: raw });
    expect(await activity.readActivityWindow()).toEqual({ ok: false, reason: kind === 'stale' ? 'data_stale' : 'data_unavailable' });
  });

  it('KV 障害 / target 不正 / MGET 不正形 / throw は unavailable', async () => {
    for (const value of [{ ok: false, reason: 'unconfigured' }, { ok: true, value: null },
      { ok: true, value: '1e2' }, { ok: true, value: '23' }, { ok: true, value: '999999999999999999' }]) {
      mocks.get.mockResolvedValue(value);
      expect(await activity.readActivityWindow()).toEqual({ ok: false, reason: 'data_unavailable' });
    }
    mocks.get.mockResolvedValue({ ok: true, value: '100' });
    for (const value of [{ ok: false, reason: 'timeout' }, { ok: true, value: [] }, { ok: true, value: null }]) {
      mocks.mget.mockResolvedValue(value);
      expect(await activity.readActivityWindow()).toEqual({ ok: false, reason: 'data_unavailable' });
    }
    mocks.mget.mockRejectedValue(new Error('KV exception'));
    expect(await activity.readActivityWindow()).toEqual({ ok: false, reason: 'data_unavailable' });
  });
});

describe('scan は18チャンク・4並列・バケット単位で全か無', () => {
  it('100ブロックずつ18回、headerは両端2回、eligibleだけ保存', async () => {
    let active = 0;
    let maximum = 0;
    mocks.getLogs.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return [{ args: { from: SENDER, to: RECEIVER, value: 1n } },
        { args: { from: SENDER, to: RECEIVER, value: 0n } }];
    });
    const result = await activity.scanActivityBucket(100);
    expect(maximum).toBe(4);
    expect(mocks.getBlock.mock.calls).toEqual([[{ blockNumber: 180_000n }], [{ blockNumber: 181_799n }]]);
    expect(mocks.getLogs).toHaveBeenCalledTimes(18);
    mocks.getLogs.mock.calls.forEach(([request], i) => {
      expect(request.fromBlock).toBe(180_000n + BigInt(i) * 100n);
      expect(request.toBlock - request.fromBlock).toBe(99n);
      expect(request.address).toBe(ACTIVITY_CONTRACT);
    });
    expect(result.items).toHaveLength(18);
    expect(result.eventCount).toBe(36);
  });

  it('後続チャンクの失敗で先行成功も捨て、次batchは開始しない', async () => {
    let calls = 0;
    mocks.getLogs.mockImplementation(async () => { if (++calls === 5) throw new Error('chunk failed'); return []; });
    await expect(activity.scanActivityBucket(100)).rejects.toThrow('chunk failed');
    expect(mocks.getLogs).toHaveBeenCalledTimes(8);
  });

  it('20s timeout 後の遅延完了は新しいチャンクを発行しない', async () => {
    mocks.getLogs.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 21_000)));
    const scan = expect(activity.scanActivityBucket(100)).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(20_000);
    await scan;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.getLogs).toHaveBeenCalledTimes(4);
  });

  it.each([5_000, 5_001])('%s eligible 件の overflow 境界 (走査は最後まで継続)', async (count) => {
    mocks.getLogs.mockResolvedValueOnce(Array.from({ length: count }, () => ({ args: { from: SENDER, to: RECEIVER, value: 1n } })));
    const result = await activity.scanActivityBucket(100);
    expect(result.overflow).toBe(count > 5_000);
    expect(result.items).toHaveLength(count > 5_000 ? 0 : count);
    expect(result.eventCount).toBe(count);
    expect(mocks.getLogs).toHaveBeenCalledTimes(18);
  });

  it.each([{ args: {} }, { removed: true, args: { from: SENDER, to: RECEIVER, value: 1n } }])('不正ログはバケット全体を拒否', async (log) => {
    mocks.getLogs.mockResolvedValueOnce([log]);
    await expect(activity.scanActivityBucket(100)).rejects.toThrow('invalid Transfer log');
  });
});
