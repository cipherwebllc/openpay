import {
  createCatalogResolver,
  createFileSpendStore,
  createPaymentExecutor,
  createPaymentSession,
  createReceiptSignerResolver,
  createSigner,
  formatAtomicJpyc,
  readRuntimeConfig,
  safeErrorMessage,
  SIGNER_MODES,
} from 'openpay-x402-sdk';

const TOOL_DEFINITIONS = [
  {
    name: 'discovery_search',
    profiles: ['x402'],
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
    profiles: ['x402'],
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
    profiles: ['x402'],
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
    profiles: ['order', 'x402'],
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
    profiles: ['x402'],
    description:
      "⚠️ Do NOT use this to estimate/quote what a PERSON pays — for a human paying by hand (the normal case, incl. any 'how much / quote / 見積もり' question) use order_summary + createOrderLink. order_quote is ONLY for the rare case where the AGENT ITSELF holds a funded key and auto-pays via x402: it fetches the x402 challenge where the BUYER pays the ~1% fee on top (total = price + fee) and is subject to MAX_PER_CALL_JPYC / session guards. Builds an agent-order for an OpenPay @handle shop; does not pay — pay the returned url with x402_pay. Items with options: pass items[].options (ids from order_menu; required groups mandatory).",
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
    profiles: ['order', 'x402'],
    description:
      "DEFAULT for a mobile order a PERSON will pay — use this for any 'how much will I pay / quote / estimate / 見積もり' question. Returns the exact amount the customer pays from their own wallet: the subtotal (the shop absorbs the ~1% service fee, so the customer is charged NO extra — e.g. a 1700 order shows 1700, not 1717). Pair with createOrderLink to hand the person a checkout link. No key, no buyer fee upcharge, no payment-limit guards. (Do NOT use order_quote for a person's estimate — that is the agent-auto-pay path and adds the fee to the buyer.)",
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
    profiles: ['order', 'x402'],
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
  {
    name: 'find_shops',
    profiles: ['order', 'x402'],
    description:
      'Find OpenPay mobile-order shops by name for free. Returns handle, name, mode, and acceptingNow; no wallet key needed.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_shops',
    profiles: ['x402'],
    description:
      'Search detailed OpenPay shop data for 2 JPYC plus the x402 fee. Reuses x402_pay and requires maxTotalJpyc so all local money guards run before payment.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', maxLength: 100 },
        mode: { type: 'string', enum: ['storefront', 'preorder'] },
        dineIn: { type: 'boolean' },
        acceptingNow: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        offset: { type: 'integer', minimum: 0, maximum: 1000 },
        maxTotalJpyc: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
      required: ['maxTotalJpyc'],
      additionalProperties: false,
    },
  },
];

function publicTool({ profiles: _profiles, ...tool }) {
  return tool;
}

export const TOOLS = TOOL_DEFINITIONS.map(publicTool);

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
  profile = 'x402',
  env = process.env,
  fetchImpl = fetch,
  nowSec = () => Math.floor(Date.now() / 1000),
  // MAX_DAILY_JPYC 設定時の日次支出ストア (テスト注入用)。既定はホームディレクトリの
  // ファイルストア (~/.openpay-x402/spend.json・SDK 0.5.0)。
  spendStore,
} = {}) {
  if (profile !== 'order' && profile !== 'x402') {
    throw new Error(`invalid profile: ${profile}`);
  }
  const profileDefinitions = TOOL_DEFINITIONS.filter((tool) =>
    tool.profiles.includes(profile),
  );
  const tools = profileDefinitions.map(publicTool);
  const allowedToolNames = new Set(profileDefinitions.map((tool) => tool.name));
  const knownToolNames = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  const config = readRuntimeConfig(env);
  const session = createPaymentSession();
  const sessionSigner =
    config.signerMode === SIGNER_MODES.steward
      ? createSigner(env, { fetchImpl })
      : null;
  let envKeySigner = null;
  function getEnvKeySigner() {
    envKeySigner ??= createSigner(env, { fetchImpl });
    return envKeySigner;
  }
  const signer =
    sessionSigner ??
    (config.buyerPrivateKey !== null
      ? {
          get address() {
            return getEnvKeySigner().address;
          },
          signTypedData(typedData) {
            return getEnvKeySigner().signTypedData(typedData);
          },
        }
      : null);
  const resolveCatalogListings = createCatalogResolver({ config, fetchImpl });
  const resolveReceiptSigner = createReceiptSignerResolver({
    discoveryUrl: config.discoveryUrl,
    fetchImpl,
  });
  // 日次上限 (MAX_DAILY_JPYC) が設定されたときだけ永続ストアを用意する。未設定なら
  // spendStore ごと null = 従来経路 (SDK 側で load すら走らない)。
  const dailySpendStore =
    config.maxDailyAtomic !== null && config.maxDailyAtomic !== undefined
      ? (spendStore ?? createFileSpendStore())
      : null;
  const paymentExecutor = createPaymentExecutor({
    config,
    session,
    signer,
    fetchImpl,
    nowSec,
    resolveCatalogListings,
    resolveReceiptSigner,
    spendStore: dailySpendStore,
  });

  // agent-order は discovery と同一 origin (config.discoveryUrl の origin) に対して menu/pay を叩く。
  function baseOrigin() {
    return new URL(config.discoveryUrl).origin;
  }

  function appendOptionalString(params, input, key) {
    const value = input[key];
    if (value === undefined) return;
    if (typeof value !== 'string') throw new Error(`${key} must be a string`);
    if (value.length > 0) params.set(key, value);
  }

  function appendOptionalBoolean(params, input, key) {
    const value = input[key];
    if (value === undefined) return;
    if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
    params.set(key, String(value));
  }

  function appendOptionalInteger(params, input, key, minimum) {
    const value = input[key];
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${key} must be an integer >= ${minimum}`);
    }
    params.set(key, String(value));
  }

  async function findShops(args) {
    const input = requireArgsObject(args);
    const params = new URLSearchParams();
    appendOptionalString(params, input, 'q');
    appendOptionalInteger(params, input, 'limit', 1);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const url = `${baseOrigin()}/api/shops/find${query}`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    const body = await readJson(res);
    if (!res.ok || !isObject(body) || !Array.isArray(body.items)) {
      return { ok: false, status: res.status, error: 'shops_find_unavailable' };
    }
    return {
      ok: true,
      ...body,
      nextStep:
        'Next: call order_menu(handle) to get the menu, then createOrderLink after choosing items.',
    };
  }

  async function searchShops(args) {
    const input = requireArgsObject(args);
    const params = new URLSearchParams();
    appendOptionalString(params, input, 'q');
    if (input.mode !== undefined) {
      if (input.mode !== 'storefront' && input.mode !== 'preorder') {
        throw new Error('mode must be storefront or preorder');
      }
      params.set('mode', input.mode);
    }
    appendOptionalBoolean(params, input, 'dineIn');
    appendOptionalBoolean(params, input, 'acceptingNow');
    appendOptionalInteger(params, input, 'limit', 1);
    appendOptionalInteger(params, input, 'offset', 0);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const url = `${baseOrigin()}/api/paid/jpyc-shops/search${query}`;
    // quote → guard →署名/支払い→解錠は既存 x402_pay の直列化を含む実装へ委譲する。
    return x402Pay({ url, maxTotalJpyc: input.maxTotalJpyc });
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
    return paymentExecutor.quote(input.url);
  }

  // 掟 15: 決済状態の真実は facilitator の verify/settle とオンチェーンのみ。x402_pay の結果を読む
  // LLM は `status: 200` を「支払い済み」と解釈しがちなので、SDK が返す settlement を **その場の
  // 1 文で** 明示し、verified 以外を支払い証明として扱わせない。B9: `verified` も「discovery
  // origin が公開する署名鍵で領収書の署名が検証できた」だけで、オンチェーンの証明ではない。
  function settlementNote(settlement) {
    return `settlement: ${settlement} — verified only means the receipt signature is valid for the signer published by the discovery origin, not on-chain proof; treat unverified/receipt_unavailable as not proven paid`;
  }

  async function x402Pay(args) {
    const input = requireArgsObject(args);
    if (typeof input.url !== 'string') throw new Error('url is required');
    const result = await paymentExecutor.pay(input.url, {
      maxTotalJpyc: input.maxTotalJpyc,
    });
    // guard 拒否 (settlement を持たない quote 形) はそのまま返す — 支払いは発生していない。
    if (!isObject(result) || typeof result.settlement !== 'string') return result;
    return { ...result, settlementNote: settlementNote(result.settlement) };
  }

  async function callTool(name, args) {
    if (knownToolNames.has(name) && !allowedToolNames.has(name)) {
      return textResult({ ok: false, error: 'tool_not_in_profile' }, true);
    }
    try {
      if (name === 'discovery_search') return textResult(await discoverySearch(args));
      if (name === 'x402_quote') return textResult(await x402Quote(args));
      if (name === 'x402_pay') return textResult(await x402Pay(args));
      if (name === 'order_menu') return textResult(await orderMenu(args));
      if (name === 'order_quote') return textResult(await orderQuote(args));
      if (name === 'order_summary') return textResult(await orderSummary(args));
      if (name === 'createOrderLink') return textResult(await createOrderLink(args));
      if (name === 'find_shops') return textResult(await findShops(args));
      if (name === 'search_shops') return textResult(await searchShops(args));
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
    tools,
    callTool,
    discoverySearch,
    x402Quote,
    x402Pay,
    orderMenu,
    orderQuote,
    orderSummary,
    createOrderLink,
    findShops,
    searchShops,
  };
}
