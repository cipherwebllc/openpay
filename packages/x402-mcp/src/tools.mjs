import {
  buildTypedDataFromPaymentRequirements,
  createAuthorization,
  decodePaymentResponse,
  encodePaymentPayload,
  paymentPayloadFor,
} from './payment.mjs';
import {
  createPaymentSession,
  evaluatePaymentGuards,
  formatAtomicJpyc,
  readRuntimeConfig,
  recordSuccessfulPayment,
  safeErrorMessage,
} from './guards.mjs';
import { createSigner, SIGNER_MODES } from './signer.mjs';

export const TOOLS = [
  {
    name: 'discovery_search',
    description: 'Search OpenPay x402 JPYC resources without paying.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'x402_quote',
    description: 'Fetch an x402 payment challenge and report price, fee, total and guard reasons. This does not pay.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'x402_pay',
    description: 'Pay an OpenPay forwarder-split x402 URL after all local money guards pass.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxTotalJpyc: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
      required: ['url', 'maxTotalJpyc'],
      additionalProperties: false,
    },
  },
  {
    name: 'order_menu',
    description:
      "Read an OpenPay @handle shop's public mobile-order menu (item ids, names, prices). No payment.",
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
      },
      required: ['handle'],
      additionalProperties: false,
    },
  },
  {
    name: 'order_quote',
    description:
      'Build an agent-order for an OpenPay @handle shop and fetch its x402 challenge (price, fee, total, guard reasons). This does not pay — pay the returned url with x402_pay. Note: an order total often exceeds the default MAX_PER_CALL_JPYC (10 JPYC); raise it to allow payment.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              qty: { type: 'number' },
            },
            required: ['id', 'qty'],
            additionalProperties: false,
          },
        },
        table: { type: 'string' },
        pickupAt: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['handle', 'items'],
      additionalProperties: false,
    },
  },
];

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function textResult(value, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          value,
          (_key, item) => (typeof item === 'bigint' ? item.toString() : item),
          2,
        ),
      },
    ],
    isError,
  };
}

async function readJson(res) {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function firstAccept(body) {
  if (!isObject(body) || !Array.isArray(body.accepts) || body.accepts.length === 0) {
    return null;
  }
  return body.accepts[0];
}

function itemText(item) {
  return [item.resource, item.description, item.category]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function summarizeDiscoveryItem(item) {
  const accept = Array.isArray(item.accepts) ? item.accepts[0] : undefined;
  const openpay = isObject(accept?.extra) ? accept.extra.openpay : undefined;
  const merchantValue = isObject(openpay) ? openpay.merchantValue : undefined;
  const feeValue = isObject(openpay) ? openpay.feeValue : undefined;
  const priceAtomic =
    typeof merchantValue === 'string' && /^[0-9]+$/.test(merchantValue)
      ? BigInt(merchantValue)
      : null;
  const feeAtomic =
    typeof feeValue === 'string' && /^[0-9]+$/.test(feeValue)
      ? BigInt(feeValue)
      : null;
  const totalAtomic =
    priceAtomic !== null && feeAtomic !== null ? priceAtomic + feeAtomic : null;

  return {
    resource: item.resource,
    description: item.description,
    category: item.category,
    priceJpyc: priceAtomic === null ? item.priceJpyc : formatAtomicJpyc(priceAtomic),
    feeJpyc: feeAtomic === null ? null : formatAtomicJpyc(feeAtomic),
    totalJpyc: totalAtomic === null ? null : formatAtomicJpyc(totalAtomic),
    network: item.network ?? accept?.network,
  };
}

function quoteShape(url, status, guard) {
  return {
    url,
    status,
    ok: guard.ok,
    reasons: guard.reasons,
    priceJpyc: guard.summary?.priceJpyc ?? null,
    feeJpyc: guard.summary?.feeJpyc ?? null,
    totalJpyc: guard.summary?.totalJpyc ?? null,
    network: guard.summary?.network ?? null,
    asset: guard.summary?.asset ?? null,
    description: undefined,
  };
}

function requireArgsObject(args) {
  if (!isObject(args)) throw new Error('tool arguments must be an object');
  return args;
}

export function createToolRuntime({
  env = process.env,
  fetchImpl = fetch,
  nowSec = () => Math.floor(Date.now() / 1000),
} = {}) {
  const config = readRuntimeConfig(env);
  const session = createPaymentSession();
  const sessionSigner =
    config.signerMode === SIGNER_MODES.steward
      ? createSigner(env, { fetchImpl })
      : null;

  function signerAvailable() {
    if (config.signerMode === SIGNER_MODES.steward) return sessionSigner !== null;
    return config.buyerPrivateKey !== null;
  }

  function paymentSigner() {
    return sessionSigner ?? createSigner(env, { fetchImpl });
  }

  // カタログ信頼: 掲載 URL の Set を 5 分キャッシュで解決する。取得失敗は null (= 信頼拡張なし・
  // ALLOWED_HOSTS のみ) に倒し、支払いを誤って広げない。
  let catalogUrlsCache = null;
  let catalogUrlsCachedAt = 0;
  async function resolveCatalogUrls() {
    if (!config.catalogTrust) return null;
    if (catalogUrlsCache && Date.now() - catalogUrlsCachedAt < 5 * 60_000) return catalogUrlsCache;
    try {
      const res = await fetchImpl(config.discoveryUrl, { headers: { accept: 'application/json' } });
      const body = await readJson(res);
      if (!res.ok || !isObject(body) || !Array.isArray(body.items)) return null;
      const urls = new Set();
      for (const item of body.items) {
        if (isObject(item) && typeof item.resource === 'string') {
          try {
            urls.add(new URL(item.resource).toString());
          } catch {
            /* 不正 URL はスキップ */
          }
        }
      }
      catalogUrlsCache = urls;
      catalogUrlsCachedAt = Date.now();
      return urls;
    } catch {
      return null;
    }
  }

  // agent-order は discovery と同一 origin (config.discoveryUrl の origin) に対して menu/pay を叩く。
  function baseOrigin() {
    return new URL(config.discoveryUrl).origin;
  }

  // カート [{id,qty}] → base64url(JSON)。server の lib/agentOrder.decodeAgentCart と同形 (単一情報源で
  // ないため両者を base64url(JSON [{id,qty}]) 契約で揃える)。@handle は正規化 (server が normalizeHandle
  // でストリップ・小文字化するため、resource 照合を通すには MCP も同じ形で送る)。
  function encodeCart(items) {
    const json = JSON.stringify(items.map((i) => ({ id: i.id, qty: i.qty })));
    return Buffer.from(json, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  function normalizeHandle(raw) {
    return String(raw).trim().replace(/^@+/, '').toLowerCase();
  }

  // 正規順 (h, cart, table, pickupAt) の pay URL。server の canonicalResourceUrl と同順・同エンコード
  // (URLSearchParams) で組み、accepts.resource === この url を成立させる (guard の resourceMismatch 回避)。
  function buildOrderPayUrl(handle, items, table, pickupAt) {
    const params = new URLSearchParams();
    params.set('h', handle);
    params.set('cart', encodeCart(items));
    if (typeof table === 'string' && table.length > 0) params.set('table', table);
    if (pickupAt !== undefined && pickupAt !== null && String(pickupAt).length > 0) {
      params.set('pickupAt', String(pickupAt));
    }
    return `${baseOrigin()}/api/agent-order/pay?${params.toString()}`;
  }

  async function orderMenu(args) {
    const input = requireArgsObject(args);
    if (typeof input.handle !== 'string' || input.handle.length === 0) {
      throw new Error('handle is required');
    }
    const handle = normalizeHandle(input.handle);
    const url = `${baseOrigin()}/api/agent-order/menu?h=${encodeURIComponent(handle)}`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const body = await readJson(res);
    if (!res.ok || !isObject(body) || !Array.isArray(body.items)) {
      return { ok: false, status: res.status, error: 'menu_unavailable' };
    }
    return { ok: true, ...body };
  }

  async function orderQuote(args) {
    const input = requireArgsObject(args);
    if (typeof input.handle !== 'string' || input.handle.length === 0) {
      throw new Error('handle is required');
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('items must be a non-empty array');
    }
    const items = input.items.map((it) => {
      if (!isObject(it) || typeof it.id !== 'string' || it.id.length === 0) {
        throw new Error('each item needs a string id');
      }
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1) {
        throw new Error('each item needs an integer qty >= 1');
      }
      return { id: it.id, qty };
    });
    const handle = normalizeHandle(input.handle);
    const url = buildOrderPayUrl(handle, items, input.table, input.pickupAt);
    // 支払いは既存 x402_pay {url, maxTotalJpyc} で行う (ガード/カタログ信頼/Steward 署名はそのまま)。
    return x402Quote({ url });
  }

  async function discoverySearch(args) {
    const input = requireArgsObject(args);
    const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
    const category =
      typeof input.category === 'string' ? input.category.toLowerCase() : '';
    const res = await fetchImpl(config.discoveryUrl, {
      headers: { accept: 'application/json' },
    });
    const body = await readJson(res);
    if (!res.ok || !isObject(body) || !Array.isArray(body.items)) {
      return { ok: false, status: res.status, error: 'discovery_unavailable' };
    }
    const items = body.items
      .filter((item) => isObject(item))
      .filter((item) => (category ? String(item.category).toLowerCase() === category : true))
      .filter((item) => (query ? itemText(item).includes(query) : true))
      .map(summarizeDiscoveryItem);
    return { ok: true, count: items.length, items };
  }

  async function x402Quote(args) {
    const input = requireArgsObject(args);
    if (typeof input.url !== 'string') throw new Error('url is required');
    const res = await fetchImpl(input.url, {
      headers: { accept: 'application/json' },
    });
    const body = await readJson(res);
    const accept = firstAccept(body);
    if (res.status !== 402 || accept === null) {
      return {
        url: input.url,
        status: res.status,
        ok: false,
        reasons: ['expected_402_with_accepts'],
      };
    }
    const guard = evaluatePaymentGuards({
      url: input.url,
      accept,
      config,
      sessionSpentAtomic: session.spentAtomic,
      catalogUrls: await resolveCatalogUrls(),
    });
    return quoteShape(input.url, res.status, guard);
  }

  async function x402Pay(args) {
    const input = requireArgsObject(args);
    if (typeof input.url !== 'string') throw new Error('url is required');
    const res = await fetchImpl(input.url, {
      headers: { accept: 'application/json' },
    });
    const body = await readJson(res);
    const accept = firstAccept(body);
    if (res.status !== 402 || accept === null) {
      return {
        url: input.url,
        status: res.status,
        ok: false,
        reasons: ['expected_402_with_accepts'],
      };
    }
    const guard = evaluatePaymentGuards({
      url: input.url,
      accept,
      config,
      sessionSpentAtomic: session.spentAtomic,
      maxTotalJpyc: input.maxTotalJpyc,
      requireMaxTotal: true,
      requireSigner: true,
      signerAvailable: signerAvailable(),
      catalogUrls: await resolveCatalogUrls(),
    });
    if (!guard.ok) return quoteShape(input.url, res.status, guard);

    const signer = paymentSigner();
    const authorization = createAuthorization(
      signer.address,
      guard.accept.maxTimeoutSeconds,
      nowSec(),
    );
    const { accept: normalizedAccept, typedData } =
      buildTypedDataFromPaymentRequirements(accept, authorization);
    const signature = await signer.signTypedData(typedData);
    const paymentPayload = paymentPayloadFor(
      normalizedAccept,
      authorization,
      signature,
    );
    const unlocked = await fetchImpl(input.url, {
      headers: {
        accept: 'application/json',
        'X-PAYMENT': encodePaymentPayload(paymentPayload),
      },
    });
    const unlockedBody = await readJson(unlocked);
    if (unlocked.status >= 200 && unlocked.status < 300) {
      recordSuccessfulPayment(session, guard.summary.totalAtomic);
    }
    const receipt = decodePaymentResponse(unlocked.headers.get('x-payment-response'));
    return {
      status: unlocked.status,
      body: unlockedBody,
      receipt,
    };
  }

  async function callTool(name, args) {
    try {
      if (name === 'discovery_search') return textResult(await discoverySearch(args));
      if (name === 'x402_quote') return textResult(await x402Quote(args));
      if (name === 'x402_pay') return textResult(await x402Pay(args));
      if (name === 'order_menu') return textResult(await orderMenu(args));
      if (name === 'order_quote') return textResult(await orderQuote(args));
      return textResult({ ok: false, error: `unknown tool: ${name}` }, true);
    } catch (error) {
      return textResult(
        { ok: false, error: safeErrorMessage(error, config) },
        true,
      );
    }
  }

  return {
    config,
    session,
    tools: TOOLS,
    callTool,
    discoverySearch,
    x402Quote,
    x402Pay,
    orderMenu,
    orderQuote,
  };
}
