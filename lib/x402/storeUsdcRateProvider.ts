import 'server-only';

import { parseUnits } from 'viem';
import {
  convertAnchorAmount,
  FX_LKG_MAX_AGE_MS,
  QR_EXPIRY_SECONDS,
  rateIsSane,
} from '@/lib/fx';
import { kvEval, kvGet, kvSet } from '@/lib/kv';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=jpy';
const RATE_SCALE = 1_000_000n;
const CACHE_TTL_SEC = 60;
const RATE_CACHE_KEY = 'store:fx:usdc-jpy:cache:v1';
const RATE_LKG_KEY = 'store:fx:usdc-jpy:lkg:v1';
const LKG_INSTALL_RETRIES = 4;

const INSTALL_LKG = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current then return 0 end
elseif current ~= ARGV[2] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`;

export const STORE_USDC_RATE_DEVIATION_BPS = 1_000;

export type StoreUsdcRateSnapshot = {
  rate: number;
  rateScaled: string;
  fetchedAt: number;
};

export type StoreUsdcQuote = StoreUsdcRateSnapshot & {
  usdcQuoteAtomic: string;
  fxQuoteExpiresAt: number;
  rounding: 'ceil';
};

type StoredRate = StoreUsdcRateSnapshot;

function parseStoredRate(raw: string | null): StoredRate | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRate>;
    if (
      typeof value.rate !== 'number' ||
      !rateIsSane(value.rate) ||
      typeof value.rateScaled !== 'string' ||
      !/^[1-9][0-9]*$/.test(value.rateScaled) ||
      typeof value.fetchedAt !== 'number' ||
      !Number.isSafeInteger(value.fetchedAt) ||
      value.fetchedAt < 0 ||
      BigInt(value.rateScaled) !== rateToScaled(value.rate)
    ) {
      return null;
    }
    return value as StoredRate;
  } catch {
    return null;
  }
}

export function rateToScaled(rate: number): bigint {
  return BigInt(Math.round(rate * Number(RATE_SCALE)));
}

/** ±10% は許容し、境界を 1 atomic でも超えた場合だけ hard reject する。 */
export function storeUsdcRateBreaksLkg(
  lkgRateScaled: bigint,
  nextRateScaled: bigint,
): boolean {
  if (lkgRateScaled <= 0n || nextRateScaled <= 0n) return true;
  const delta =
    nextRateScaled >= lkgRateScaled
      ? nextRateScaled - lkgRateScaled
      : lkgRateScaled - nextRateScaled;
  return delta * 10_000n >
    lkgRateScaled * BigInt(STORE_USDC_RATE_DEVIATION_BPS);
}

export async function getStoreUsdcRate(input: {
  now?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<
  | { ok: true; snapshot: StoreUsdcRateSnapshot }
  | { ok: false; reason: 'unavailable' | 'out_of_band' | 'circuit_open' }
> {
  const now = input.now ?? Date.now();
  const [cachedRead, lkgRead] = await Promise.all([
    kvGet(RATE_CACHE_KEY),
    kvGet(RATE_LKG_KEY),
  ]);
  if (!lkgRead.ok) return { ok: false, reason: 'unavailable' };
  const lkg = parseStoredRate(lkgRead.value);
  if (lkgRead.value !== null && !lkg) {
    return { ok: false, reason: 'unavailable' };
  }
  if (cachedRead.ok) {
    const cached = parseStoredRate(cachedRead.value);
    if (
      cached &&
      cached.fetchedAt <= now &&
      now - cached.fetchedAt <= CACHE_TTL_SEC * 1_000
    ) {
      if (!lkg || lkg.fetchedAt > now) {
        return { ok: false, reason: 'unavailable' };
      }
      return storeUsdcRateBreaksLkg(
        BigInt(lkg.rateScaled),
        BigInt(cached.rateScaled),
      )
        ? { ok: false, reason: 'circuit_open' }
        : { ok: true, snapshot: cached };
    }
  }

  let response: Response;
  let data: { 'usd-coin'?: { jpy?: unknown } };
  try {
    response = await (input.fetchImpl ?? fetch)(COINGECKO_URL, {
      cache: 'no-store',
      headers: { 'User-Agent': 'OpenPay/1.0 (https://open-pay.jp)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    data = (await response.json()) as typeof data;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const rate = data['usd-coin']?.jpy;
  if (typeof rate !== 'number' || !rateIsSane(rate)) {
    return { ok: false, reason: 'out_of_band' };
  }
  // fetch/parse が完了した時刻が上流の実取得時刻。API response の生成時刻は流用しない。
  const fetchedAt = input.now ?? Date.now();
  const rateScaled = rateToScaled(rate);
  const snapshot: StoreUsdcRateSnapshot = {
    rate,
    rateScaled: rateScaled.toString(),
    fetchedAt,
  };
  // compare→install を CAS に閉じ、同時 fetch が互いの LKG 更新を追い越して ±10% fence を
  // すり抜けないようにする。競合時は最新 LKG を再読込し、同じ upstream snapshot を再判定。
  let expectedRaw = lkgRead.value;
  for (let attempt = 0; attempt < LKG_INSTALL_RETRIES; attempt += 1) {
    const current = parseStoredRate(expectedRaw);
    if (expectedRaw !== null && !current) {
      return { ok: false, reason: 'unavailable' };
    }
    if (current && current.fetchedAt > fetchedAt) {
      return { ok: false, reason: 'unavailable' };
    }
    if (
      current &&
      fetchedAt - current.fetchedAt <= FX_LKG_MAX_AGE_MS &&
      storeUsdcRateBreaksLkg(BigInt(current.rateScaled), rateScaled)
    ) {
      return { ok: false, reason: 'circuit_open' };
    }
    const installed = await kvEval<number>(
      INSTALL_LKG,
      [RATE_LKG_KEY],
      [
        expectedRaw === null ? '1' : '0',
        expectedRaw ?? '',
        JSON.stringify(snapshot),
        String(Math.ceil(FX_LKG_MAX_AGE_MS / 1_000)),
      ],
    );
    if (!installed.ok) return { ok: false, reason: 'unavailable' };
    if (installed.value === 1) {
      expectedRaw = JSON.stringify(snapshot);
      break;
    }
    const latest = await kvGet(RATE_LKG_KEY);
    if (!latest.ok) return { ok: false, reason: 'unavailable' };
    expectedRaw = latest.value;
  }
  if (expectedRaw !== JSON.stringify(snapshot)) {
    return { ok: false, reason: 'unavailable' };
  }
  // cache 障害は次回の upstream fetch 増加にだけ影響し、LKG fence 自体は残る。
  await kvSet(RATE_CACHE_KEY, JSON.stringify(snapshot), {
    ttlSec: CACHE_TTL_SEC,
  });
  return { ok: true, snapshot };
}

export async function quoteStoreJpycInUsdc(input: {
  priceJpyc: string;
  intentExpiresAt: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; quote: StoreUsdcQuote }
  | { ok: false; reason: 'unavailable' | 'out_of_band' | 'circuit_open' }
> {
  const rate = await getStoreUsdcRate(input);
  if (!rate.ok) return rate;
  const converted = convertAnchorAmount({
    anchorAmount: input.priceJpyc,
    anchorSymbol: 'jpyc',
    targetSymbol: 'usdc',
    usdcJpy: rate.snapshot.rate,
  });
  if (!converted.ok) {
    return {
      ok: false,
      reason:
        converted.reason === 'out-of-band' ? 'out_of_band' : 'unavailable',
    };
  }
  let usdcQuoteAtomic: bigint;
  try {
    usdcQuoteAtomic = parseUnits(converted.amount, 6);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const fxQuoteExpiresAt = Math.min(
    input.intentExpiresAt,
    rate.snapshot.fetchedAt + QR_EXPIRY_SECONDS * 1_000,
  );
  return {
    ok: true,
    quote: {
      ...rate.snapshot,
      usdcQuoteAtomic: usdcQuoteAtomic.toString(),
      fxQuoteExpiresAt,
      rounding: 'ceil',
    },
  };
}
