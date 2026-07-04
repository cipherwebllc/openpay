import { privateKeyToAccount } from 'viem/accounts';
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
      requirePrivateKey: true,
    });
    if (!guard.ok) return quoteShape(input.url, res.status, guard);

    const account = privateKeyToAccount(config.buyerPrivateKey);
    const authorization = createAuthorization(
      account.address,
      guard.accept.maxTimeoutSeconds,
      nowSec(),
    );
    const { accept: normalizedAccept, typedData } =
      buildTypedDataFromPaymentRequirements(accept, authorization);
    const signature = await account.signTypedData(typedData);
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
  };
}
