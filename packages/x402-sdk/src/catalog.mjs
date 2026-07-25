import {
  DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  fetchPaymentTarget,
} from './network.mjs';

export const CATALOG_CACHE_MS = 5 * 60_000;

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createCatalogCache() {
  return { listings: null, cachedAt: 0 };
}

export async function resolveCatalogListings({
  config,
  fetchImpl = fetch,
  lookup,
  requestTimeoutMs = DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  now = Date.now,
  cache = createCatalogCache(),
}) {
  if (!config.catalogTrust) return null;
  if (
    cache.listings !== null &&
    now() - cache.cachedAt < CATALOG_CACHE_MS
  ) {
    return cache.listings;
  }

  try {
    const response = await fetchPaymentTarget(config.discoveryUrl, {
      fetchImpl,
      lookup,
      timeoutMs: requestTimeoutMs,
      headers: { accept: 'application/json' },
    });
    const body = await readJson(response);
    if (!response.ok || !isObject(body) || !Array.isArray(body.items)) {
      return null;
    }
    const listings = new Map();
    for (const item of body.items) {
      if (
        isObject(item) &&
        typeof item.resource === 'string' &&
        Array.isArray(item.accepts) &&
        item.accepts.length > 0
      ) {
        try {
          listings.set(new URL(item.resource).toString(), item.accepts[0]);
        } catch {
          // One malformed catalog entry must not hide otherwise valid listings.
        }
      }
    }
    cache.listings = listings;
    cache.cachedAt = now();
    return listings;
  } catch {
    // A discovery outage must not expand trust beyond the explicit host allowlist.
    return null;
  }
}

export function createCatalogResolver({
  config,
  fetchImpl = fetch,
  lookup,
  requestTimeoutMs = DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  now = Date.now,
}) {
  const cache = createCatalogCache();
  return () =>
    resolveCatalogListings({
      config,
      fetchImpl,
      lookup,
      requestTimeoutMs,
      now,
      cache,
    });
}
