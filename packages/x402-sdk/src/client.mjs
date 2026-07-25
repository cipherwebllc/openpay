import { createCatalogResolver } from './catalog.mjs';
import { createPaymentExecutor } from './executor.mjs';
import {
  createPaymentSession,
  formatAtomicJpyc,
  parseClientOptions,
  safeErrorMessage,
} from './guards.mjs';
import { createSignerFromOptions } from './signer.mjs';
import { createFileSpendStore } from './spendStore.mjs';
import { createReceiptSignerResolver } from './receipt.mjs';

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function requireArgsObject(value, label) {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
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

async function freeApiResponse(response, fallbackError) {
  const body = await readJson(response);
  if (response.ok) return { ok: true, status: response.status, body };
  const error =
    isObject(body) && typeof body.error === 'string'
      ? body.error
      : fallbackError;
  return { ok: false, status: response.status, error, body };
}

function appendOptionalString(url, input, key) {
  const value = input[key];
  if (value === undefined) return;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  if (value.length > 0) url.searchParams.set(key, value);
}

function appendOptionalLimit(url, input) {
  const value = input.limit;
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('limit must be an integer >= 1');
  }
  url.searchParams.set('limit', String(value));
}

export function createOpenPayClient(options = {}) {
  const config = parseClientOptions(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchImpl must be a function');
  }
  const signer = createSignerFromOptions(options, { fetchImpl });
  const session = createPaymentSession();
  const spendStore =
    config.maxDailyAtomic === null
      ? null
      : options.spendStore ?? createFileSpendStore();
  const resolveCatalogListings = createCatalogResolver({
    config,
    fetchImpl,
    lookup: options.lookup,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const resolveReceiptSigner = createReceiptSignerResolver({
    discoveryUrl: config.discoveryUrl,
    fetchImpl,
    lookup: options.lookup,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const executor = createPaymentExecutor({
    config,
    session,
    signer,
    signerAddress: signer?.address ?? null,
    spendStore,
    fetchImpl,
    lookup: options.lookup,
    requestTimeoutMs: options.requestTimeoutMs,
    nowSec: options.nowSec,
    now: options.now,
    resolveCatalogListings,
    resolveReceiptSigner,
  });

  async function withSafeErrors(operation) {
    try {
      return await operation();
    } catch (error) {
      throw new Error(safeErrorMessage(error, config));
    }
  }

  async function discover(args = {}) {
    return withSafeErrors(async () => {
      const input = requireArgsObject(args, 'discover options');
      const url = new URL(config.discoveryUrl);
      appendOptionalString(url, input, 'query');
      appendOptionalString(url, input, 'category');
      const response = await fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
      });
      return freeApiResponse(response, 'discovery_unavailable');
    });
  }

  async function findShops(args = {}) {
    return withSafeErrors(async () => {
      const input = requireArgsObject(args, 'findShops options');
      const url = new URL('/api/shops/find', new URL(config.discoveryUrl).origin);
      appendOptionalString(url, input, 'q');
      appendOptionalLimit(url, input);
      const response = await fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
      });
      return freeApiResponse(response, 'shops_find_unavailable');
    });
  }

  const client = {
    discover,
    findShops,
    quote: executor.quote,
    pay: executor.pay,
  };
  Object.defineProperty(client, 'session', {
    configurable: false,
    enumerable: false,
    get() {
      return Object.freeze({
        spentAtomic: session.spentAtomic,
        spentJpyc: formatAtomicJpyc(session.spentAtomic),
      });
    },
  });
  return Object.freeze(client);
}
