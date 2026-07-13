import type { MobileOrderMode } from '@/lib/mobileOrder';
import { parseHHMM } from '@/lib/shopTime';

export const SHOPS_DEFAULT_LIMIT = 20;
export const SHOPS_MAX_LIMIT = 20;
export const SHOPS_MAX_OFFSET = 1000;
export const SHOPS_MAX_QUERY_LENGTH = 100;
export const SHOPS_FIND_DEFAULT_LIMIT = 10;
export const SHOPS_FIND_MAX_LIMIT = 10;

export const SHOPS_LICENSE_NOTICE = {
  ja: '店舗が自ら掲載に同意した公開情報。利用範囲は検索/注文支援。最新情報は pageUrl で再確認。',
  en: 'Public information listed with each shop’s consent. Permitted use: search/order assistance. Recheck current details at pageUrl.',
} as const;

const SHOP_MODES = ['storefront', 'preorder'] as const;
const SHOP_CHAINS = ['polygon', 'kaia', 'avalanche', 'ethereum'] as const;
const QUERY_KEYS = new Set([
  'q',
  'mode',
  'dineIn',
  'acceptingNow',
  'limit',
  'offset',
]);
const FIND_QUERY_KEYS = new Set(['q', 'limit']);
const HANDLE_RE = /^[a-z0-9_]{3,30}$/;
const DECIMAL_RE = /^\d{1,12}(?:\.\d{1,18})?$/;
const DATE_MAX_MS = 8_640_000_000_000_000;

export type ShopChain = (typeof SHOP_CHAINS)[number];

export type ShopSummary = {
  handle: string;
  name: string;
  tagline?: string;
  address?: string;
  mode: MobileOrderMode;
  dineIn: boolean;
  /** PR-2 以降の summary は常に boolean。PR-1 既存値の欠落は判定不能として保持する。 */
  acceptingOrders?: boolean;
  openFrom?: string;
  lastOrder?: string;
  minLeadMinutes?: number;
  menu: {
    itemCount: number;
    minPrice: string;
    maxPrice: string;
    /** acceptingNow の全品売切判定専用。公開 item には写像しない。 */
    itemIds?: readonly string[];
  };
  /** 注文 API が実際に使う既定 chain。PR-1 既存 summary では欠落しうる。 */
  chain?: ShopChain;
  chains: readonly ShopChain[];
  updatedAt: number;
};

export type AcceptingNow = true | false | null;

export type ShopSearchQuery = {
  q?: string;
  mode?: MobileOrderMode;
  dineIn?: boolean;
  acceptingNow?: boolean;
  limit: number;
  offset: number;
};

export type ShopFindQuery = {
  q?: string;
  limit: number;
};

export type ShopSearchItem = {
  handle: string;
  name: string;
  tagline?: string;
  address?: string;
  mode: MobileOrderMode;
  dineIn: boolean;
  acceptingNow: AcceptingNow;
  openFrom?: string;
  lastOrder?: string;
  minLeadMinutes?: number;
  menu: { itemCount: number; minPrice: string; maxPrice: string };
  chains: readonly ShopChain[];
  pageUrl: string;
  menuUrl: string;
  live: { paused: boolean; soldOutCount: number; updatedAt: number } | null;
  /** envelope の freshness 算出用。route が公開前に除去する。 */
  sourceUpdatedAt: number;
};

export type PublicShopSearchItem = Omit<ShopSearchItem, 'sourceUpdatedAt'>;

export type ShopsEnvelope<TQuery, TItem> = {
  schemaVersion: '1.0';
  query: TQuery;
  items: readonly TItem[];
  total: number;
  generatedAt: string;
  dataFreshness: {
    oldestUpdatedAt: string | null;
    newestUpdatedAt: string | null;
  };
  licenseNotice: typeof SHOPS_LICENSE_NOTICE;
  attribution: readonly string[];
};

export type ShopQueryValidation =
  | { ok: true; value: ShopSearchQuery }
  | { ok: false; error: 'invalid_query' };

export type ShopFindQueryValidation =
  | { ok: true; value: ShopFindQuery }
  | { ok: false; error: 'invalid_query' };

function nonEmptyString(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || value.length > maxLength) return null;
  return trimmed;
}

function booleanFilter(raw: string | null): boolean | undefined | null {
  if (raw === null || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

function boundedInteger(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) return null;
  return Math.min(value, max);
}

function decimalAtomic(value: string): bigint {
  const [integer, fraction = ''] = value.split('.');
  return (
    BigInt(integer) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
  );
}

/** materialized JSON は untrusted storage として allowlist から再構築する。 */
export function parseShopSummary(raw: string | null | undefined): ShopSummary | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const handle = nonEmptyString(record.handle, 32);
  const name = nonEmptyString(record.name, 80);
  const tagline = nonEmptyString(record.tagline, 60);
  const address = nonEmptyString(record.address, 120);
  if (
    !handle ||
    !HANDLE_RE.test(handle) ||
    !name ||
    tagline === null ||
    address === null ||
    !SHOP_MODES.includes(record.mode as MobileOrderMode) ||
    typeof record.dineIn !== 'boolean' ||
    (record.mode === 'preorder' && record.dineIn) ||
    (record.acceptingOrders !== undefined &&
      typeof record.acceptingOrders !== 'boolean') ||
    !record.menu ||
    typeof record.menu !== 'object' ||
    !Array.isArray(record.chains) ||
    record.chains.length === 0 ||
    (record.chain !== undefined &&
      (typeof record.chain !== 'string' ||
        !SHOP_CHAINS.includes(record.chain as ShopChain))) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < 0 ||
    record.updatedAt > DATE_MAX_MS
  ) {
    return null;
  }

  const menu = record.menu as Record<string, unknown>;
  if (
    typeof menu.itemCount !== 'number' ||
    !Number.isSafeInteger(menu.itemCount) ||
    menu.itemCount < 1 ||
    menu.itemCount > 60 ||
    typeof menu.minPrice !== 'string' ||
    !DECIMAL_RE.test(menu.minPrice) ||
    typeof menu.maxPrice !== 'string' ||
    !DECIMAL_RE.test(menu.maxPrice) ||
    decimalAtomic(menu.minPrice) <= 0n ||
    decimalAtomic(menu.minPrice) > decimalAtomic(menu.maxPrice)
  ) {
    return null;
  }

  let itemIds: readonly string[] | undefined;
  if (menu.itemIds !== undefined) {
    if (
      !Array.isArray(menu.itemIds) ||
      menu.itemIds.length !== menu.itemCount ||
      menu.itemIds.some(
        (item) =>
          typeof item !== 'string' ||
          item.trim().length === 0 ||
          item.length > 64,
      ) ||
      new Set(menu.itemIds).size !== menu.itemIds.length
    ) {
      return null;
    }
    itemIds = menu.itemIds as string[];
  }

  const chains: ShopChain[] = [];
  for (const chain of record.chains) {
    if (
      typeof chain !== 'string' ||
      !SHOP_CHAINS.includes(chain as ShopChain) ||
      chains.includes(chain as ShopChain)
    ) {
      return null;
    }
    chains.push(chain as ShopChain);
  }
  if (
    record.chain !== undefined &&
    !chains.includes(record.chain as ShopChain)
  ) {
    return null;
  }

  const openFrom = nonEmptyString(record.openFrom, 5);
  const lastOrder = nonEmptyString(record.lastOrder, 5);
  if (
    openFrom === null ||
    lastOrder === null ||
    (openFrom !== undefined && parseHHMM(openFrom) === null) ||
    (lastOrder !== undefined && parseHHMM(lastOrder) === null) ||
    (record.minLeadMinutes !== undefined &&
      (typeof record.minLeadMinutes !== 'number' ||
        !Number.isSafeInteger(record.minLeadMinutes) ||
        record.minLeadMinutes < 1 ||
        record.minLeadMinutes > 1440))
  ) {
    return null;
  }

  return {
    handle,
    name,
    ...(tagline ? { tagline } : {}),
    ...(address ? { address } : {}),
    mode: record.mode as MobileOrderMode,
    dineIn: record.dineIn,
    ...(record.acceptingOrders === undefined
      ? {}
      : { acceptingOrders: record.acceptingOrders }),
    ...(openFrom ? { openFrom } : {}),
    ...(lastOrder ? { lastOrder } : {}),
    ...(record.minLeadMinutes === undefined
      ? {}
      : { minLeadMinutes: record.minLeadMinutes as number }),
    menu: {
      itemCount: menu.itemCount,
      minPrice: menu.minPrice,
      maxPrice: menu.maxPrice,
      ...(itemIds ? { itemIds } : {}),
    },
    ...(record.chain === undefined ? {} : { chain: record.chain as ShopChain }),
    chains,
    updatedAt: record.updatedAt,
  };
}

export function validateShopQuery(
  searchParams: URLSearchParams,
): ShopQueryValidation {
  for (const key of searchParams.keys()) {
    if (!QUERY_KEYS.has(key)) return { ok: false, error: 'invalid_query' };
  }
  const qRaw = searchParams.get('q');
  const q = qRaw?.trim() || undefined;
  const modeRaw = searchParams.get('mode');
  const mode =
    modeRaw === null || modeRaw === ''
      ? undefined
      : SHOP_MODES.includes(modeRaw as MobileOrderMode)
        ? (modeRaw as MobileOrderMode)
        : null;
  const dineIn = booleanFilter(searchParams.get('dineIn'));
  const acceptingNow = booleanFilter(searchParams.get('acceptingNow'));
  const limit = boundedInteger(
    searchParams.get('limit'),
    SHOPS_DEFAULT_LIMIT,
    1,
    SHOPS_MAX_LIMIT,
  );
  const offset = boundedInteger(
    searchParams.get('offset'),
    0,
    0,
    SHOPS_MAX_OFFSET,
  );
  if (
    (q && q.length > SHOPS_MAX_QUERY_LENGTH) ||
    mode === null ||
    dineIn === null ||
    acceptingNow === null ||
    limit === null ||
    offset === null
  ) {
    return { ok: false, error: 'invalid_query' };
  }
  return {
    ok: true,
    value: {
      ...(q ? { q } : {}),
      ...(mode ? { mode } : {}),
      ...(dineIn === undefined ? {} : { dineIn }),
      ...(acceptingNow === undefined ? {} : { acceptingNow }),
      limit,
      offset,
    },
  };
}

export function validateShopFindQuery(
  searchParams: URLSearchParams,
): ShopFindQueryValidation {
  for (const key of searchParams.keys()) {
    if (!FIND_QUERY_KEYS.has(key)) return { ok: false, error: 'invalid_query' };
  }
  const qRaw = searchParams.get('q');
  const q = qRaw?.trim() || undefined;
  const limit = boundedInteger(
    searchParams.get('limit'),
    SHOPS_FIND_DEFAULT_LIMIT,
    1,
    SHOPS_FIND_MAX_LIMIT,
  );
  if ((q && q.length > SHOPS_MAX_QUERY_LENGTH) || limit === null) {
    return { ok: false, error: 'invalid_query' };
  }
  return {
    ok: true,
    value: { ...(q ? { q } : {}), limit },
  };
}

export function findShopSummaries(
  summaries: readonly ShopSummary[],
  query: ShopFindQuery,
): { items: readonly ShopSummary[]; total: number } {
  const keyword = query.q?.toLowerCase();
  const matches = keyword
    ? summaries.filter((summary) => summary.name.toLowerCase().includes(keyword))
    : summaries;
  return { items: matches.slice(0, query.limit), total: matches.length };
}

export function queryShops(
  items: readonly ShopSearchItem[],
  query: ShopSearchQuery,
): { items: readonly ShopSearchItem[]; total: number } {
  const keyword = query.q?.toLowerCase();
  const matches = items.filter((item) => {
    if (
      keyword &&
      ![item.name, item.tagline, item.address].some((field) =>
        field?.toLowerCase().includes(keyword),
      )
    ) {
      return false;
    }
    if (query.mode && item.mode !== query.mode) return false;
    if (query.dineIn !== undefined && item.dineIn !== query.dineIn) return false;
    // true filter は true だけを採用し、障害/判定不能の null を受付中に混ぜない。
    if (
      query.acceptingNow !== undefined &&
      item.acceptingNow !== query.acceptingNow
    ) {
      return false;
    }
    return true;
  });
  return {
    items: matches.slice(query.offset, query.offset + query.limit),
    total: matches.length,
  };
}

function isoTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function createShopsEnvelope<TQuery, TItem>(
  query: TQuery,
  result: { items: readonly TItem[]; total: number },
  generatedAt: string,
  sources: readonly { updatedAt: number; pageUrl: string }[],
): ShopsEnvelope<TQuery, TItem> {
  let oldest: number | null = null;
  let newest: number | null = null;
  const attribution = new Set<string>();
  for (const source of sources) {
    if (oldest === null || source.updatedAt < oldest) oldest = source.updatedAt;
    if (newest === null || source.updatedAt > newest) newest = source.updatedAt;
    attribution.add(source.pageUrl);
  }
  return {
    schemaVersion: '1.0',
    query,
    items: result.items,
    total: result.total,
    generatedAt,
    dataFreshness: {
      oldestUpdatedAt: oldest === null ? null : isoTimestamp(oldest),
      newestUpdatedAt: newest === null ? null : isoTimestamp(newest),
    },
    licenseNotice: SHOPS_LICENSE_NOTICE,
    attribution: [...attribution],
  };
}

export function publicShopSearchItem(item: ShopSearchItem): PublicShopSearchItem {
  const { sourceUpdatedAt: _sourceUpdatedAt, ...publicItem } = item;
  return publicItem;
}
