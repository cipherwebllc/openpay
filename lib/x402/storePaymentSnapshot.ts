import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import type {
  PurchaseGrant,
  PurchaseOwnership,
} from '@/lib/x402/purchaseIntent';
import { parsePurchaseOwnership } from '@/lib/x402/purchaseIntent';

export const STORE_PAYMENT_SNAPSHOT_VERSION = 1;

export type StoreUsdcPaymentSnapshot = {
  version: typeof STORE_PAYMENT_SNAPSHOT_VERSION;
  rail: 'usdc';
  asset: Address;
  assetSymbol: 'USDC';
  chainId: 8453;
  paidAtomic: string;
  priceJpyc: string;
  quote: {
    rateScaled: string;
    rateFetchedAt: number;
    fxQuoteExpiresAt: number;
    rounding: 'ceil';
  };
};

export type StorePurchaseGrant = PurchaseGrant & {
  payment?: StoreUsdcPaymentSnapshot;
};

export type StorePurchaseOwnership = Omit<
  PurchaseOwnership,
  'grants' | 'latestGrant'
> & {
  grants: StorePurchaseGrant[];
  latestGrant: StorePurchaseGrant;
};

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const BASE_NATIVE_USDC = getAddress(
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
);

export function parseStorePaymentSnapshot(
  value: unknown,
): StoreUsdcPaymentSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  const quote = snapshot.quote;
  if (
    snapshot.version !== STORE_PAYMENT_SNAPSHOT_VERSION ||
    snapshot.rail !== 'usdc' ||
    typeof snapshot.asset !== 'string' ||
    !isAddress(snapshot.asset) ||
    !isAddressEqual(snapshot.asset, BASE_NATIVE_USDC) ||
    snapshot.assetSymbol !== 'USDC' ||
    snapshot.chainId !== 8453 ||
    typeof snapshot.paidAtomic !== 'string' ||
    !DECIMAL_RE.test(snapshot.paidAtomic) ||
    BigInt(snapshot.paidAtomic) <= 0n ||
    typeof snapshot.priceJpyc !== 'string' ||
    !DECIMAL_RE.test(snapshot.priceJpyc) ||
    BigInt(snapshot.priceJpyc) <= 0n ||
    !quote ||
    typeof quote !== 'object' ||
    Array.isArray(quote)
  ) {
    return null;
  }
  const q = quote as Record<string, unknown>;
  if (
    typeof q.rateScaled !== 'string' ||
    !/^[1-9][0-9]*$/.test(q.rateScaled) ||
    typeof q.rateFetchedAt !== 'number' ||
    !Number.isSafeInteger(q.rateFetchedAt) ||
    q.rateFetchedAt < 0 ||
    typeof q.fxQuoteExpiresAt !== 'number' ||
    !Number.isSafeInteger(q.fxQuoteExpiresAt) ||
    q.fxQuoteExpiresAt <= q.rateFetchedAt ||
    q.fxQuoteExpiresAt > q.rateFetchedAt + 180_000 ||
    q.rounding !== 'ceil'
  ) {
    return null;
  }
  return {
    version: STORE_PAYMENT_SNAPSHOT_VERSION,
    rail: 'usdc',
    asset: BASE_NATIVE_USDC,
    assetSymbol: 'USDC',
    chainId: 8453,
    paidAtomic: snapshot.paidAtomic,
    priceJpyc: snapshot.priceJpyc,
    quote: {
      rateScaled: q.rateScaled,
      rateFetchedAt: q.rateFetchedAt,
      fxQuoteExpiresAt: q.fxQuoteExpiresAt,
      rounding: 'ceil',
    },
  };
}

/**
 * v1 JPYC ownership parser は変更せず、その検証結果へ USDC snapshot だけを再付与する。
 * snapshot 無しは旧 JPYC grant のままであり、既定値を注入しない。
 */
export function parseStorePurchaseOwnership(
  raw: unknown,
): StorePurchaseOwnership | null {
  const base = parsePurchaseOwnership(raw);
  if (!base || typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stored = value as { grants?: unknown; latestGrant?: unknown };
  if (!Array.isArray(stored.grants) || stored.grants.length !== base.grants.length) {
    return null;
  }
  const rawGrants = stored.grants;
  const grants = base.grants.map((grant, index): StorePurchaseGrant | null => {
    const rawGrant = rawGrants[index];
    if (!rawGrant || typeof rawGrant !== 'object' || Array.isArray(rawGrant)) {
      return null;
    }
    const paymentRaw = (rawGrant as Record<string, unknown>).payment;
    if (paymentRaw === undefined) return grant;
    const payment = parseStorePaymentSnapshot(paymentRaw);
    return payment ? { ...grant, payment } : null;
  });
  if (grants.some((grant) => grant === null)) return null;
  const typedGrants = grants as StorePurchaseGrant[];
  const latestGrant = typedGrants.find(
    (grant) => grant.intentSalt === base.latestGrant.intentSalt,
  );
  if (!latestGrant) return null;
  const rawLatestGrant = stored.latestGrant;
  if (
    !rawLatestGrant ||
    typeof rawLatestGrant !== 'object' ||
    Array.isArray(rawLatestGrant)
  ) {
    return null;
  }
  const latestPaymentRaw = (rawLatestGrant as Record<string, unknown>).payment;
  if (latestPaymentRaw === undefined) {
    if (latestGrant.payment !== undefined) return null;
  } else {
    const latestPayment = parseStorePaymentSnapshot(latestPaymentRaw);
    if (
      !latestPayment ||
      JSON.stringify(latestPayment) !== JSON.stringify(latestGrant.payment)
    ) {
      return null;
    }
  }
  return { ...base, grants: typedGrants, latestGrant };
}
