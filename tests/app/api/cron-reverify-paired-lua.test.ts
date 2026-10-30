// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, runRedisLua, type FakeRedisStore } from '../../_helpers/redisLua';

// 再検証は Vercel Cron (毎時 0 分) と GitHub Actions (予備・遅れて同じ UTC 時に来る) の 2 つから起動される。
// 二重起動でも「失敗カウンタは 1 時間に 1 回しか進まない (hidden が早まらない)・probe は 1 回・cursor は壊れない」
// ことを、本物の route と本物の Lua (lock・CAS・cursor) で確かめる。差し替えるのは KV の土台と probe だけ。
type Probe = (url: string) => Promise<{ verdict: string; authClass: string }>;
const holder = vi.hoisted(() => ({
  store: null as FakeRedisStore | null,
  probe: null as unknown as Mock<Probe>,
}));
vi.mock('@/lib/kv', () => ({
  kvEndpointInfo: () => ({ host: null, source: null }),
  kvGet: async (key: string) => ({ ok: true, value: holder.store!.strings.get(key) ?? null }),
  kvSet: async (key: string, value: string, opts: { nx?: boolean } = {}) => {
    if (opts.nx && holder.store!.strings.has(key)) return { ok: true, value: null };
    holder.store!.strings.set(key, value);
    return { ok: true, value: 'OK' };
  },
  kvLrange: async (key: string, start: number, stop: number) => ({
    ok: true,
    value: (holder.store!.lists.get(key) ?? []).slice(start, stop + 1),
  }),
  kvEval: async (script: string, keys: string[], args: string[]) => ({
    ok: true, value: await runRedisLua(script, keys, args, holder.store!),
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/x402/firstParty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/firstParty')>()), FIRST_PARTY_RESOURCES: [],
}));
vi.mock('@/lib/x402/reverify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/x402/reverify')>()),
  probeForReverifyDetailed: (url: string) => holder.probe(url),
}));

import { REVERIFY_CURSOR_KEY, REVERIFY_HIDE_THRESHOLD, REVERIFY_LOCK_KEY } from '@/lib/x402/reverify';
import { RESOURCES_INDEX, resourceKey } from '@/lib/x402/registry';
import { GET } from '@/app/api/cron/reverify/route';

const URL = 'https://example.com/api';
const request = () => new Request('https://open-pay.jp/api/cron/reverify', { headers: { authorization: 'Bearer test' } });
const stored = () => JSON.parse(holder.store!.strings.get(resourceKey('a'))!);
const cursor = () => JSON.parse(holder.store!.strings.get(REVERIFY_CURSOR_KEY)!);
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at('2026-10-30T05:00:00.000Z');
  holder.store = createFakeRedisStore();
  holder.probe = vi.fn<Probe>(async () => ({ verdict: 'violation_gone', authClass: 'neutral' }));
  // 違反があと 2 回で hidden になる掲載 1 件。directory の検査は今日すでに済んでいる (この test の対象外)。
  holder.store.strings.set(resourceKey('a'), JSON.stringify({
    id: 'a', url: URL, active: true, hidden: false, merchant: '0x1111111111111111111111111111111111111111',
    verification: { probedUrl: URL, failures: REVERIFY_HIDE_THRESHOLD - 2, lastRunId: 'old', lastCheckedAt: 'old' },
  }));
  holder.store.lists.set(RESOURCES_INDEX, ['a']);
  holder.store.strings.set(REVERIFY_CURSOR_KEY, JSON.stringify({ offset: 0, directoryDate: '2026-10-30' }));
  vi.stubEnv('CRON_SECRET', 'test');
  vi.stubEnv('ALERT_WEBHOOK_URL', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
afterAll(closeRedisLuaEngine);

describe('reverify の二重起動 (同じ UTC 時・本物の Lua)', () => {
  it('続けての 2 回目は probe せず、掲載のカウンタを動かさない。cursor は壊さず、lastOkAt (心拍) だけ進む', async () => {
    const first = await GET(request());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ runId: '2026103005', checked: 1, violations: 1, skippedDuplicate: 0 });
    const afterFirst = holder.store!.strings.get(resourceKey('a'));
    expect(stored()).toMatchObject({
      hidden: false,
      verification: { failures: REVERIFY_HIDE_THRESHOLD - 1, lastRunId: '2026103005' },
    });
    expect(cursor()).toEqual({ offset: 0, directoryDate: '2026-10-30', lastOkAt: '2026-10-30T05:00:00.000Z' });

    // GitHub の予備が遅れて同じ UTC 時に来る。
    at('2026-10-30T05:40:00.000Z');
    const second = await GET(request());
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ runId: '2026103005', checked: 0, violations: 0, skippedDuplicate: 1 });
    expect(holder.probe).toHaveBeenCalledTimes(1);
    expect(holder.store!.strings.get(resourceKey('a'))).toBe(afterFirst);
    expect(cursor()).toEqual({ offset: 0, directoryDate: '2026-10-30', lastOkAt: '2026-10-30T05:40:00.000Z' });
    expect(holder.store!.strings.has(REVERIFY_LOCK_KEY)).toBe(false);

    // 次の UTC 時になって初めてカウンタが進み、閾値で hidden になる (= 二重起動で hidden が早まらない)。
    at('2026-10-30T06:00:00.000Z');
    expect((await GET(request())).status).toBe(200);
    expect(holder.probe).toHaveBeenCalledTimes(2);
    expect(stored()).toMatchObject({
      hidden: true,
      verification: { failures: REVERIFY_HIDE_THRESHOLD, lastRunId: '2026103006' },
    });
  });

  it('同時の 2 回は lock で片方が skipped になり、probe もカウンタも 1 回分', async () => {
    const [a, b] = await Promise.all([GET(request()), GET(request())]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()];
    expect(bodies.filter((body) => body.skipped === 'locked')).toEqual([{ runId: '2026103005', skipped: 'locked' }]);
    expect(holder.probe).toHaveBeenCalledTimes(1);
    expect(stored().verification.failures).toBe(REVERIFY_HIDE_THRESHOLD - 1);
    expect(cursor()).toEqual({ offset: 0, directoryDate: '2026-10-30', lastOkAt: '2026-10-30T05:00:00.000Z' });
    expect(holder.store!.strings.has(REVERIFY_LOCK_KEY)).toBe(false);
  });
});
