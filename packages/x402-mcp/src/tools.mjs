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
    description:
      'Pay an OpenPay forwarder-split x402 URL after all local money guards pass. Only when the agent itself holds a funded key and auto-pays (x402, buyer covers the ~1% fee). For human-pays, use order_summary + createOrderLink instead.',
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
      "Read an OpenPay @handle shop's public mobile-order menu (item ids, names, prices). No payment, no key needed.",
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
      'Build an agent-order for an OpenPay @handle shop and fetch its x402 challenge (price, fee, total, guard reasons). Only when the agent itself holds a funded key and auto-pays (x402, buyer covers the ~1% fee); for human-pays, use order_summary + createOrderLink instead. Items with options: pass items[].options (ids from order_menu; required groups mandatory). This does not pay — pay the returned url with x402_pay. Note: an order total often exceeds the default MAX_PER_CALL_JPYC (10 JPYC); raise it to allow payment.',
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
              options: {
                description:
                  'Option selections: {groupId: choiceId} (single) / {groupId: [choiceIds]} (multi). Ids from order_menu; required groups mandatory.',
                type: 'object',
                additionalProperties: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } },
                  ],
                },
              },
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
  {
    name: 'order_summary',
    description:
      "For the human-pays flow (customer pays from their own wallet). Returns the amount the customer actually pays (subtotal; the shop covers the ~1% service fee). Use this + createOrderLink for 'my AI plans the order, I pay by hand'. No key needed.",
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
              options: {
                description:
                  'Option selections: {groupId: choiceId} (single) / {groupId: [choiceIds]} (multi). Ids from order_menu; required groups mandatory.',
                type: 'object',
                additionalProperties: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } },
                  ],
                },
              },
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
  {
    name: 'createOrderLink',
    description:
      "Build a human-facing checkout link for an OpenPay @handle shop's mobile order. No wallet or key needed: this only assembles a URL — the traveler opens it on their phone and pays from their own wallet. Returns `${origin}/@<handle>?cart=<base64url>[&table][&pickupAt]`. The shop's receiving address and prices are re-resolved server-side from the @handle record (never carried in the link), so menu text cannot change the destination or amount. Use this for the \"my AI plans the order, I pay by hand\" handoff (pair with order_summary to tell the customer the exact amount they pay); use order_quote + x402_pay only when the agent itself holds a funded key and auto-pays.",
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
              options: {
                description:
                  'Option selections: {groupId: choiceId} (single) / {groupId: [choiceIds]} (multi). Ids from order_menu; required groups mandatory.',
                type: 'object',
                additionalProperties: {
                  oneOf: [
                    { type: 'string' },
                    { type: 'array', items: { type: 'string' } },
                  ],
                },
              },
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

// カート入力 [{id, qty, options?}] を検証・正規化する (order_quote / createOrderLink 共通)。
// options はここで **落とさず** そのまま運ぶ (0.5.0 で {id, qty} を組み直して options が脱落した
// 実バグの再発防止)。値の妥当性 (group/choice の実在・required) はサーバーが権威検証する。
function normalizeCartItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('items must be a non-empty array');
  }
  return rawItems.map((it) => {
    if (!isObject(it) || typeof it.id !== 'string' || it.id.length === 0) {
      throw new Error('each item needs a string id');
    }
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new Error('each item needs an integer qty >= 1');
    }
    let options;
    if (it.options !== undefined) {
      if (!isObject(it.options) || Array.isArray(it.options)) {
        throw new Error('item options must be an object of {groupId: choiceId | choiceId[]}');
      }
      for (const v of Object.values(it.options)) {
        const okValue =
          typeof v === 'string' || (Array.isArray(v) && v.every((c) => typeof c === 'string'));
        if (!okValue) {
          throw new Error('item options values must be a string or an array of strings');
        }
      }
      options = it.options;
    }
    return { id: it.id, qty, ...(options ? { options } : {}) };
  });
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

  // カタログ信頼: 掲載「URL → 掲載 accept[0] (OpenPay サーバー生成の権威値)」の Map を 5 分
  // キャッシュで解決する。取得失敗は null (= 信頼拡張なし・ALLOWED_HOSTS のみ) に倒し、支払いを
  // 誤って広げない。掲載 accept は guard がライブ accept と照合し、第三者ドメインの bait-and-switch
  // (別 forwarder/asset で buyer に攻撃者宛署名を作らせる) を拒否するために使う。
  let catalogUrlsCache = null;
  let catalogUrlsCachedAt = 0;
  async function resolveCatalogListings() {
    if (!config.catalogTrust) return null;
    if (catalogUrlsCache && Date.now() - catalogUrlsCachedAt < 5 * 60_000) return catalogUrlsCache;
    try {
      const res = await fetchImpl(config.discoveryUrl, { headers: { accept: 'application/json' } });
      const body = await readJson(res);
      if (!res.ok || !isObject(body) || !Array.isArray(body.items)) return null;
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
            /* 不正 URL はスキップ */
          }
        }
      }
      catalogUrlsCache = listings;
      catalogUrlsCachedAt = Date.now();
      return listings;
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
    const json = JSON.stringify(
      items.map((i) => ({
        id: i.id,
        qty: i.qty,
        ...(i.options && typeof i.options === 'object' ? { options: i.options } : {}),
      })),
    );
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
    const items = normalizeCartItems(input.items);
    const handle = normalizeHandle(input.handle);
    const url = buildOrderPayUrl(handle, items, input.table, input.pickupAt);
    // 支払いは既存 x402_pay {url, maxTotalJpyc} で行う (ガード/カタログ信頼/Steward 署名はそのまま)。
    return x402Quote({ url });
  }

  // 人払い (createOrderLink → @handle?cart= checkout) の実額を読む読み取り専用の summary URL。
  // 正規順 (h, cart, table, pickupAt) で組む (order_quote の pay URL と同順・同エンコード)。
  function buildOrderSummaryUrl(handle, items, table, pickupAt) {
    const params = new URLSearchParams();
    params.set('h', handle);
    params.set('cart', encodeCart(items));
    if (typeof table === 'string' && table.length > 0) params.set('table', table);
    if (pickupAt !== undefined && pickupAt !== null && String(pickupAt).length > 0) {
      params.set('pickupAt', String(pickupAt));
    }
    return `${baseOrigin()}/api/agent-order/summary?${params.toString()}`;
  }

  // 人払いの内訳を返す (鍵不要・**支払いは発生しない**)。/api/agent-order/summary は store-borne
  // (customerPaysJpyc = 小計・feeBearer='merchant' = 店が ~1% を吸収) を返す。x402 の買い手上乗せ
  // (order_quote) とは別物 — 人が自分のウォレットで払う額を order_quote と混同させないための経路。
  async function orderSummary(args) {
    const input = requireArgsObject(args);
    if (typeof input.handle !== 'string' || input.handle.length === 0) {
      throw new Error('handle is required');
    }
    const items = normalizeCartItems(input.items);
    const handle = normalizeHandle(input.handle);
    const url = buildOrderSummaryUrl(handle, items, input.table, input.pickupAt);
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const body = await readJson(res);
    if (!res.ok || !isObject(body)) {
      return { ok: false, status: res.status, error: 'summary_unavailable' };
    }
    return { ok: true, ...body };
  }

  // 人間が開く事前充填リンク: `${origin}/@<handle>?cart=<base64url>[&table][&pickupAt]`。
  // **鍵不要・非カストディ** — URL を組むだけで署名も送金もしない (客が自分のウォレットで払う)。
  // 受取先・価格は URL に載せず (cart は {id, qty, options} のみ)、server が @handle の KV レコードから
  // 再解決する (メニュー文字列が受取先/金額に影響しない・receiver スプーフィング不成立: plans §2 M2/C1)。
  // cart 直列化は order_quote と同じ encodeCart = server の lib/agentOrder.encodeAgentCart と同形式。
  function buildOrderLinkUrl(handle, items, table, pickupAt) {
    const params = new URLSearchParams();
    params.set('cart', encodeCart(items));
    if (typeof table === 'string' && table.length > 0) params.set('table', table);
    if (pickupAt !== undefined && pickupAt !== null && String(pickupAt).length > 0) {
      params.set('pickupAt', String(pickupAt));
    }
    // handle は正規化済み (英数字想定) だが、想定外文字も server が decode できるよう path で encode。
    return `${baseOrigin()}/@${encodeURIComponent(handle)}?${params.toString()}`;
  }

  async function createOrderLink(args) {
    const input = requireArgsObject(args);
    if (typeof input.handle !== 'string' || input.handle.length === 0) {
      throw new Error('handle is required');
    }
    const items = normalizeCartItems(input.items);
    const handle = normalizeHandle(input.handle);
    const url = buildOrderLinkUrl(handle, items, input.table, input.pickupAt);
    return { ok: true, handle, itemCount: items.length, url };
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
      catalogListings: await resolveCatalogListings(),
    });
    return quoteShape(input.url, res.status, guard);
  }

  // 並行 x402_pay の TOCTOU を塞ぐ: read(session.spentAtomic)→署名→fetch→record の間に await が
  // 複数あり、複数の pay を同時発火すると各々が更新前の累計を見て MAX_SESSION_JPYC を超過できる。
  // セッション単位で直列化し、各 pay が直前の pay の record 後に走る (常に最新の累計を見る) ようにする。
  let payChain = Promise.resolve();
  async function x402Pay(args) {
    const run = payChain.then(
      () => x402PayImpl(args),
      () => x402PayImpl(args),
    );
    // 直前の失敗を次の pay に波及させない (結果は run が保持・チェーンは順序保証のみ)。
    payChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function x402PayImpl(args) {
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
      catalogListings: await resolveCatalogListings(),
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
      if (name === 'order_summary') return textResult(await orderSummary(args));
      if (name === 'createOrderLink') return textResult(await createOrderLink(args));
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
    orderSummary,
    createOrderLink,
  };
}
