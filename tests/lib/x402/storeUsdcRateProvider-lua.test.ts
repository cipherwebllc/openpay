// @vitest-environment node
// Store の USDC 見積もりに使う USDC/JPY の last-known-good (INSTALL_LKG) の CAS を本物の Lua で実行する
// (第 7 回レビュー F10)。同時に取得した別 instance の LKG を追い越して ±10% の急変ブレーカーをすり抜けない
// ことを、lib/kv.ts の実装ごと fake Upstash に繋いで確かめる (これまでは kvEval の JS 模倣だけだった)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRedisLuaEngine, createFakeRedisStore, fakeUpstashFetch, type FakeRedisStore } from '@/tests/_helpers/redisLua';
import { getStoreUsdcRate, rateToScaled } from '@/lib/x402/storeUsdcRateProvider';

const NOW = 1_900_000_000_000;
const LKG_KEY = 'store:fx:usdc-jpy:lkg:v1';
const CACHE_KEY = 'store:fx:usdc-jpy:cache:v1';
let store: FakeRedisStore;

const snapshot = (rate: number, fetchedAt: number) =>
  JSON.stringify({ rate, rateScaled: rateToScaled(rate).toString(), fetchedAt });

function upstream(rate: number, during?: () => void) {
  return vi.fn(async () => {
    // 取得中に別 instance が LKG を書き終えた状態を作る (同時 fetch の競合)。
    during?.();
    return Response.json({ data: { currency: 'USDC', rates: { JPY: String(rate) } } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  store = createFakeRedisStore(NOW);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-only');
  vi.stubGlobal('fetch', vi.fn(fakeUpstashFetch(store)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeRedisLuaEngine);

describe('INSTALL_LKG (real Lua)', () => {
  it('LKG が無ければ (NX 相当で) 置き、24 時間の TTL を付ける。見積もり用 cache は 60 秒', async () => {
    expect(await getStoreUsdcRate({ now: NOW, fetchImpl: upstream(150) }))
      .toEqual({ ok: true, snapshot: JSON.parse(snapshot(150, NOW)) });
    expect(store.strings.get(LKG_KEY)).toBe(snapshot(150, NOW));
    expect(store.getTtl(LKG_KEY)).toBe(86_400);
    expect(store.getTtl(CACHE_KEY)).toBe(60);
  });

  it('冪等: cache の間は取得も LKG の更新もしない。cache 切れ後は今の LKG を expected にした CAS で更新する', async () => {
    await getStoreUsdcRate({ now: NOW, fetchImpl: upstream(150) });
    const cached = upstream(151);
    expect(await getStoreUsdcRate({ now: NOW + 30_000, fetchImpl: cached })).toMatchObject({ ok: true, snapshot: { rate: 150 } });
    expect(cached).not.toHaveBeenCalled();

    store.advance(61_000);
    expect(await getStoreUsdcRate({ now: NOW + 61_000, fetchImpl: upstream(151) })).toMatchObject({ ok: true, snapshot: { rate: 151 } });
    expect(store.strings.get(LKG_KEY)).toBe(snapshot(151, NOW + 61_000));
  });

  it('競合: 取得中に別 instance が LKG を置いたら CAS は 0 → 読み直してその LKG を expected に入れ直す', async () => {
    const other = snapshot(149, NOW - 1_000);
    const result = await getStoreUsdcRate({
      now: NOW,
      fetchImpl: upstream(150, () => {
        store.strings.set(LKG_KEY, other);
        store.setTtl(LKG_KEY, 86_400);
      }),
    });
    expect(result).toMatchObject({ ok: true, snapshot: { rate: 150 } });
    expect(store.strings.get(LKG_KEY)).toBe(snapshot(150, NOW));
  });

  it('競合: 既存 LKG を expected にした CAS の間に別 instance が LKG を更新したら 0 → 新しい LKG で ±10% を判定し直す', async () => {
    // 既存 150 から見れば 160 は +6.7% で通るが、取得中に別 instance が 135 へ更新していた。古い expected のまま
    // 上書きすると 135 → 160 (+18.5%) の急変がブレーカーをすり抜ける。
    store.strings.set(LKG_KEY, snapshot(150, NOW - 3_600_000));
    store.setTtl(LKG_KEY, 86_400);
    const latest = snapshot(135, NOW - 1_000);
    const result = await getStoreUsdcRate({
      now: NOW,
      fetchImpl: upstream(160, () => {
        store.strings.set(LKG_KEY, latest);
        store.setTtl(LKG_KEY, 86_400);
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'circuit_open' });
    expect(store.strings.get(LKG_KEY)).toBe(latest);
    expect(store.strings.has(CACHE_KEY)).toBe(false);
  });

  it('競合: 別 instance の LKG の方が新しければ上書きせず unavailable (古い値で追い越さない)', async () => {
    const newer = snapshot(149, NOW + 5_000);
    const result = await getStoreUsdcRate({
      now: NOW,
      fetchImpl: upstream(150, () => {
        store.strings.set(LKG_KEY, newer);
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(store.strings.get(LKG_KEY)).toBe(newer);
    expect(store.strings.has(CACHE_KEY)).toBe(false);
  });
});
