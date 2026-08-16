import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  fail: false,
  casReplacement: null as string | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/kv', () => ({
  kvGet: vi.fn(async (key: string) =>
    state.fail
      ? { ok: false as const }
      : { ok: true as const, value: state.values.get(key) ?? null },
  ),
  kvSet: vi.fn(async (key: string, value: string) => {
    if (state.fail) return { ok: false as const };
    state.values.set(key, value);
    return { ok: true as const, value: 'OK' };
  }),
  kvEval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
    if (state.fail) return { ok: false as const };
    if (state.casReplacement !== null) {
      state.values.set(keys[0]!, state.casReplacement);
      state.casReplacement = null;
      return { ok: true as const, value: 0 };
    }
    const current = state.values.get(keys[0]!);
    const matches = args[0] === '1'
      ? current === undefined
      : current === args[1];
    if (!matches) return { ok: true as const, value: 0 };
    state.values.set(keys[0]!, args[2]!);
    return { ok: true as const, value: 1 };
  }),
}));

import {
  getStoreUsdcRate,
  quoteStoreJpycInUsdc,
  rateToScaled,
  storeUsdcRateBreaksLkg,
} from '@/lib/x402/storeUsdcRateProvider';

const NOW = 1_900_000_000_000;
const LKG_KEY = 'store:fx:usdc-jpy:lkg:v1';
const CACHE_KEY = 'store:fx:usdc-jpy:cache:v1';

function upstream(rate: number) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ 'usd-coin': { jpy: rate } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function putLkg(rate: number): void {
  state.values.set(
    LKG_KEY,
    JSON.stringify({
      rate,
      rateScaled: rateToScaled(rate).toString(),
      fetchedAt: NOW - 1_000,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.values.clear();
  state.fail = false;
  state.casReplacement = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Creator Store USDC rate provider', () => {
  it('本番 clock では request 開始でなく upstream JSON 取得完了時刻を fetchedAt にする', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(NOW - 2_000)
      .mockReturnValueOnce(NOW);
    const result = await getStoreUsdcRate({ fetchImpl: upstream(150) });
    expect(result.ok && result.snapshot.fetchedAt).toBe(NOW);
  });

  it('上流実取得時刻を snapshot し、JPYC→USDC は 6 decimals で ceil する', async () => {
    const result = await quoteStoreJpycInUsdc({
      priceJpyc: '1',
      intentExpiresAt: NOW + 600_000,
      now: NOW,
      fetchImpl: upstream(150),
    });

    expect(result).toEqual({
      ok: true,
      quote: {
        rate: 150,
        rateScaled: '150000000',
        fetchedAt: NOW,
        usdcQuoteAtomic: '6667',
        fxQuoteExpiresAt: NOW + 180_000,
        rounding: 'ceil',
      },
    });
  });

  it('fxQuoteExpiresAt は intent 期限との min を取る', async () => {
    const result = await quoteStoreJpycInUsdc({
      priceJpyc: '300',
      intentExpiresAt: NOW + 90_000,
      now: NOW,
      fetchImpl: upstream(150),
    });
    expect(result.ok && result.quote.fxQuoteExpiresAt).toBe(NOW + 90_000);
  });

  it.each([
    [165, false],
    [165.000001, true],
    [135, false],
    [134.999999, true],
  ])('LKG=150 に対する rate=%s の ±10%% 境界', async (rate, rejected) => {
    putLkg(150);
    const result = await getStoreUsdcRate({
      now: NOW,
      fetchImpl: upstream(rate),
    });
    expect(result.ok).toBe(!rejected);
    if (rejected) {
      expect(result).toEqual({ ok: false, reason: 'circuit_open' });
    }
  });

  it('sanity band 外と LKG storage 障害は quote を返さない', async () => {
    await expect(
      getStoreUsdcRate({ now: NOW, fetchImpl: upstream(49.999999) }),
    ).resolves.toEqual({ ok: false, reason: 'out_of_band' });

    state.fail = true;
    await expect(
      getStoreUsdcRate({ now: NOW, fetchImpl: upstream(150) }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('breaker の bigint 比較はちょうど ±10% を許可し、1 scaled 超を拒否する', () => {
    const lkg = 150_000_000n;
    expect(storeUsdcRateBreaksLkg(lkg, 165_000_000n)).toBe(false);
    expect(storeUsdcRateBreaksLkg(lkg, 165_000_001n)).toBe(true);
    expect(storeUsdcRateBreaksLkg(lkg, 135_000_000n)).toBe(false);
    expect(storeUsdcRateBreaksLkg(lkg, 134_999_999n)).toBe(true);
  });

  it('同時 LKG 更新に CAS で負けた場合は最新値に対して breaker を再判定する', async () => {
    putLkg(150);
    state.casReplacement = JSON.stringify({
      rate: 135,
      rateScaled: rateToScaled(135).toString(),
      fetchedAt: NOW - 500,
    });
    await expect(
      getStoreUsdcRate({ now: NOW, fetchImpl: upstream(165) }),
    ).resolves.toEqual({ ok: false, reason: 'circuit_open' });
  });

  it('古い cache が新しい LKG から ±10% を超えた race も hard reject する', async () => {
    state.values.set(
      CACHE_KEY,
      JSON.stringify({
        rate: 165,
        rateScaled: rateToScaled(165).toString(),
        fetchedAt: NOW - 1_000,
      }),
    );
    state.values.set(
      LKG_KEY,
      JSON.stringify({
        rate: 135,
        rateScaled: rateToScaled(135).toString(),
        fetchedAt: NOW - 500,
      }),
    );
    const fetchImpl = upstream(150);
    await expect(
      getStoreUsdcRate({ now: NOW, fetchImpl }),
    ).resolves.toEqual({ ok: false, reason: 'circuit_open' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
