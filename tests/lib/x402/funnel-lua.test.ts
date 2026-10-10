// @vitest-environment node
// x402 購入ファネルの日次カウンタの Lua (FUNNEL_HINCR: HINCRBY と初回だけの EXPIRE を 1 EVAL) を本物の Lua で実行する
// (Lua 登録表の計画 PR-C)。funnel.test.ts は kvEval を mock しているため、「TTL は無いときだけ付け、2 回目以降は延ばさない」
// 「TTL を失ったハッシュには付け直す (永久に残さない)」「challenge は標本 1 件で 50 を足す」は CI で一度も実行されていなかった。
// lib/x402/funnel.ts を lib/kv.ts の実装ごと fake Upstash に繋ぐ。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { FUNNEL_CHALLENGE_SAMPLE_RATE, FUNNEL_TTL_SEC, funnelField, funnelKey, recordFunnel } from '@/lib/x402/funnel';

const RESOURCE = 'https://open-pay.jp/api/paid/hello?q=1';
const KEY = funnelKey('2026-10-11');
let store: FakeRedisStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  warn.mockReset();
  store = createFakeRedisStore(1_790_000_000_000);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

const count = (field: string) => store.hashes.get(KEY)?.get(field);

describe('FUNNEL_HINCR (real Lua)', () => {
  it('段階ごとの field を 1 ずつ数え、その日のハッシュに初回だけ 180 日の TTL を付ける (2 回目以降は延ばさない)', async () => {
    await recordFunnel('settled', 'base', RESOURCE);
    expect(count(funnelField('settled', 'base', RESOURCE))).toBe('1');
    expect(store.getTtl(KEY)).toBe(FUNNEL_TTL_SEC);
    store.advance(3_600_000);
    await recordFunnel('settled', 'base', RESOURCE);
    await recordFunnel('verify_failed', 'arc-gateway', RESOURCE);
    expect(count(funnelField('settled', 'base', RESOURCE))).toBe('2');
    expect(count(funnelField('verify_failed', 'arc-gateway', RESOURCE))).toBe('1');
    expect(store.getTtl(KEY)).toBe(FUNNEL_TTL_SEC - 3_600);
    expect(warn).not.toHaveBeenCalled();
  });

  it('TTL を失ったハッシュには次の計上で付け直す (KV に永久に残さない)', async () => {
    await recordFunnel('settled', 'base', RESOURCE);
    store.persist(KEY);
    expect(store.getTtl(KEY)).toBe(-1);
    await recordFunnel('settled', 'base', RESOURCE);
    expect(store.getTtl(KEY)).toBe(FUNNEL_TTL_SEC);
    expect(count(funnelField('settled', 'base', RESOURCE))).toBe('2');
  });

  it(`challenge は標本に当たった 1 件で ${FUNNEL_CHALLENGE_SAMPLE_RATE} を足し、外れは KV に触れない`, async () => {
    await recordFunnel('challenge', 'none', RESOURCE, () => 0.5);
    expect(store.keys()).not.toContain(KEY);
    await recordFunnel('challenge', 'none', RESOURCE, () => 0);
    await recordFunnel('challenge', 'none', RESOURCE, () => 0);
    expect(count(funnelField('challenge', 'none', RESOURCE))).toBe(String(2 * FUNNEL_CHALLENGE_SAMPLE_RATE));
    expect(store.getTtl(KEY)).toBe(FUNNEL_TTL_SEC);
  });

  it('競合: 同じ field の同時計上は取りこぼさずに全部数える', async () => {
    await Promise.all(Array.from({ length: 5 }, () => recordFunnel('settled', 'base', RESOURCE)));
    expect(count(funnelField('settled', 'base', RESOURCE))).toBe('5');
    expect(store.getTtl(KEY)).toBe(FUNNEL_TTL_SEC);
  });
});
