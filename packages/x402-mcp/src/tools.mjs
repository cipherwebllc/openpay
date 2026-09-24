import {
  createCatalogResolver,
  createFileSpendStore,
  createPaymentExecutor,
  createPaymentSession,
  createReceiptSignerResolver,
  createSigner,
  createSignerFromOptions,
  formatAtomicJpyc,
  readRuntimeConfig,
  safeErrorMessage,
  SIGNER_MODES,
  SUPPORTED_JPYC_ASSETS,
} from 'openpay-x402-sdk';
import { join } from 'node:path';
import { encodeFunctionData, erc20Abi } from 'viem';
import { createWallet, loadWallet, walletDirectory } from './keystore.mjs';
import { fetchPolygonRpc } from './wallet-rpc.mjs';
import { startPurchase, endPurchase, readHistory } from './history.mjs';
import { proveWallet } from './prove.mjs';
import { createKovaSigner } from './kova-signer.mjs';

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
      "DEFAULT for a mobile order a PERSON will pay — use this for any 'how much will I pay / quote / estimate / 見積もり' question. Returns the exact amount the customer pays from their own wallet. Read customerPaysJpyc and feeBearer: usually the subtotal (storefront shops absorb the 1% service fee), but preorder shops may add a 3% fee paid by the customer. Pair with createOrderLink to hand the person a checkout link. No key or payment-limit guards. (Do NOT use order_quote for a person's estimate — that is the agent-auto-pay path and adds the fee to the buyer.)",
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
  {
    name: 'wallet_init',
    profiles: ['x402'],
    description: 'Create a local wallet in keystore mode, or reuse the existing wallet. Returns only its public address and storage metadata; never a key. Does not pay.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wallet_status',
    profiles: ['x402'],
    description: 'Read the signer address, Polygon JPYC balance when an RPC is configured, and local payment limits. Does not sign or pay.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wallet_history',
    profiles: ['x402'],
    description: 'Read recent local purchase attempts from this machine and storage location. History may be incomplete and is not proof of payment. Does not sign, pay, or create a wallet.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
      additionalProperties: false,
    },
  },
  {
    name: 'wallet_prove',
    profiles: ['x402'],
    description: 'Sign a one-time, five-minute link to bind this Agent to a signed-in OpenPay account for server-side purchase history. Do not share the link. Keystore or env-key only; does not pay or expose keys.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function publicTool({ profiles: _profiles, ...tool }) {
  return tool;
}

export const TOOLS = TOOL_DEFINITIONS.map(publicTool);

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function rawTextResult(value, isError = false) {
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
  lookup,
  // 履歴 I/O の打ち切り (テスト注入用)。既定は history.mjs の HISTORY_DEADLINE_MS。
  historyDeadlineMs,
  // Kova child process injection for tests; never installs or launches another signer.
  kovaExecFile,
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
  const kovaMode = env.SIGNER_MODE === 'kova';
  const kovaSigner = kovaMode ? createKovaSigner(env, { execFileImpl: kovaExecFile }) : null;
  // MCP's public mode is kova; SDK guards treat a custom signer as steward. An overlay
  // avoids enumerating unrelated environment values (including Kova credentials).
  const config = readRuntimeConfig(kovaMode
    ? Object.assign(Object.create(env), { SIGNER_MODE: SIGNER_MODES.steward })
    : env);
  const keystoreMode = config.signerMode === SIGNER_MODES.keystore;
  const dailyLimitSource = config.maxDailyAtomic !== null
    ? 'configured'
    : keystoreMode ? 'default_keystore' : kovaMode ? 'default_kova' : 'disabled';
  if (dailyLimitSource === 'default_keystore' || dailyLimitSource === 'default_kova') {
    config.maxDailyAtomic = config.maxSessionAtomic;
  }
  const walletEnv = { HOME: env.HOME, OPENPAY_X402_HOME: env.OPENPAY_X402_HOME };
  const rpcUrl = env.POLYGON_RPC_URL;
  let walletPrivateKey = null;
  let walletFailure = null;
  let walletSigner = null;
  const redactedKeys = new Set();
  if (keystoreMode && config.buyerPrivateKey !== null) {
    redactedKeys.add(config.buyerPrivateKey);
    config.buyerPrivateKey = null;
  }
  function redactWalletKeys(text) {
    for (const key of redactedKeys) text = text.split(key).join('[redacted_private_key]');
    return text;
  }
  function errorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return safeErrorMessage(redactWalletKeys(message), config);
  }
  function textResult(value, isError = false) {
    const result = rawTextResult(value, isError);
    // Only known keys are removed from payloads. Generic 32-byte hex redaction would destroy nonces.
    result.content[0].text = redactWalletKeys(result.content[0].text);
    return result;
  }
  function rememberWalletFailure(error) {
    walletFailure = { code: error.code ?? 'wallet_unavailable', message: errorMessage(error) };
    walletSigner = null;
    // Keep a previously loaded key in the redaction context even after disabling its signer.
    // Otherwise a failed re-init could let a later response echo that secret into tool output.
  }
  function activateWallet(wallet) {
    walletPrivateKey = wallet.secret.privateKey;
    redactedKeys.add(walletPrivateKey);
    walletSigner = createSignerFromOptions({ privateKey: walletPrivateKey });
    walletFailure = null;
  }
  // A corrupt local wallet must not take discovery/quotes down, but must prevent every signature.
  const walletReady = keystoreMode
    ? loadWallet({ env: walletEnv }).then((wallet) => {
        if (wallet !== null) activateWallet(wallet);
      }).catch(rememberWalletFailure)
    : Promise.resolve();
  const session = createPaymentSession();
  let sessionSigner = null;
  if (kovaMode) {
    sessionSigner = kovaSigner;
  } else if (config.signerMode === SIGNER_MODES.steward) {
    sessionSigner = createSigner(env, { fetchImpl });
  }
  let envKeySigner = null;
  function getEnvKeySigner() {
    envKeySigner ??= createSigner(env, { fetchImpl });
    return envKeySigner;
  }
  const signer =
    sessionSigner ??
    (keystoreMode ? {
      get address() { return walletSigner?.address ?? null; },
      get signerAvailable() { return walletSigner !== null; },
      signTypedData(typedData) {
        if (walletSigner === null) throw new Error(walletFailure?.code ?? 'wallet_not_initialized');
        return walletSigner.signTypedData(typedData);
      },
    } : config.buyerPrivateKey !== null
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
  // 有効な日次上限 (keystore / kova の既定値を含む) があるときだけ永続ストアを用意する。
  // env-key / steward の未設定時は null = 従来経路 (SDK 側で load すら走らない)。
  let dailySpendStore = spendStore ?? null;
  if (config.maxDailyAtomic !== null && dailySpendStore === null) {
    try {
      dailySpendStore = createFileSpendStore(keystoreMode || kovaMode
        ? { path: join(walletDirectory(walletEnv), 'spend.json') }
        : undefined);
    } catch (error) {
      if (!keystoreMode) throw error;
      // Invalid wallet storage must disable signing without taking discovery/status down.
      rememberWalletFailure(error);
    }
  }
  if (config.maxDailyAtomic === null) dailySpendStore = null;
  function walletSpendKey(key) {
    if (walletSigner === null || dailySpendStore === null) {
      throw new Error(walletFailure?.code ?? 'wallet_not_initialized');
    }
    return `${walletSigner.address.toLowerCase()}:${key.slice(-10)}`;
  }
  // SDK 0.9.0 captures signerAddress at construction. Translate its private placeholder
  // to the active public address at the store boundary; the placeholder is never persisted.
  const executorSpendStore = keystoreMode ? {
    load(key) { return dailySpendStore.load(walletSpendKey(key)); },
    save(key, value) { return dailySpendStore.save(walletSpendKey(key), value); },
    ...(typeof dailySpendStore?.reserve === 'function' ? {
      reserve(key, ...args) { return dailySpendStore.reserve(walletSpendKey(key), ...args); },
    } : {}),
    ...(typeof dailySpendStore?.confirm === 'function' ? {
      confirm(id) { return dailySpendStore.confirm(id); },
    } : {}),
  } : dailySpendStore;
  const paymentExecutor = createPaymentExecutor({
    config: keystoreMode ? {
      ...config,
      get buyerPrivateKey() { return walletPrivateKey; },
    } : config,
    session,
    signer,
    ...(keystoreMode ? { signerAddress: 'keystore' } : {}),
    fetchImpl,
    lookup,
    nowSec,
    resolveCatalogListings,
    resolveReceiptSigner,
    spendStore: executorSpendStore,
  });
  let walletOperations = Promise.resolve();
  function serializeWallet(operation) {
    if (!keystoreMode) return operation();
    // Reinitialization cannot change the payer halfway through an outstanding authorization.
    const run = walletOperations.then(operation, operation);
    walletOperations = run.then(() => {}, () => {});
    return run;
  }

  function fundingUrl(address) {
    return address === null ? null : `https://open-pay.jp/agent?address=${address}`;
  }

  function requireEmptyArgs(args) {
    const input = requireArgsObject(args);
    if (Array.isArray(input) || Object.keys(input).length !== 0) {
      throw new Error('wallet tools take no arguments');
    }
  }

  async function walletInitImpl(args) {
    requireEmptyArgs(args);
    if (!keystoreMode) return { ok: false, error: 'wallet_init_requires_keystore_mode' };
    await walletReady;
    try {
      const wallet = await createWallet({ env: walletEnv });
      // Idempotent init preserves the executor's queue and outstanding session reservations.
      if (walletSigner === null || wallet.secret.privateKey !== walletPrivateKey) activateWallet(wallet);
      return {
        address: wallet.public.address,
        created: wallet.public.created,
        storage: wallet.public.storage,
        fundingUrl: fundingUrl(wallet.public.address),
        note: 'OpenPay never receives, stores, or can recover this key. Anything that can run commands as you can read it. Keep only a small balance in this wallet.',
      };
    } catch (error) {
      rememberWalletFailure(error);
      return { ok: false, error: walletFailure.code, message: walletFailure.message };
    }
  }

  function walletInit(args) {
    return serializeWallet(() => walletInitImpl(args));
  }

  function walletProve(args) {
    return serializeWallet(async () => {
      requireEmptyArgs(args);
      if (config.signerMode !== SIGNER_MODES.keystore && config.signerMode !== SIGNER_MODES.envKey) {
        return { ok: false, error: 'signer_mode_unsupported' };
      }
      await walletReady;
      if (keystoreMode && !signer.signerAvailable) {
        return { ok: false, error: walletFailure?.code ?? 'wallet_not_initialized' };
      }
      if (signer === null) return { ok: false, error: 'buyer_private_key_missing' };
      // A third-party discovery catalog must never receive a purchase-history bearer proof.
      return proveWallet({ signer, origin: env.OPENPAY_ORIGIN?.trim() || undefined, fetchImpl, lookup });
    });
  }

  async function readBalance(address) {
    if (!rpcUrl) return { jpycBalance: null, balanceSource: 'no_rpc_configured' };
    let timeout;
    const controller = new AbortController();
    try {
      if (address === null) return { jpycBalance: null, balanceSource: 'rpc_error' };
      const token = SUPPORTED_JPYC_ASSETS['eip155:137'];
      const request = async () => {
        const response = await fetchPolygonRpc(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          redirect: 'error',
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{ to: token.address, data: encodeFunctionData({
              abi: erc20Abi, functionName: 'balanceOf', args: [address],
            }) }, 'latest'],
          }),
        }, { fetchImpl, lookup });
        const body = await response.json();
        if (!response.ok || body?.error || !/^0x[0-9a-fA-F]{64}$/.test(body?.result)) {
          throw new Error('invalid balance response');
        }
        return { jpycBalance: formatAtomicJpyc(BigInt(body.result)), balanceSource: 'rpc' };
      };
      // Bound both transport and body reads, even when an injected transport ignores abort.
      return await Promise.race([request(), new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('balance RPC timed out'));
        }, 5000);
      })]);
    } catch {
      // An optional balance lookup must not break status or turn an unknown balance into zero.
      return { jpycBalance: null, balanceSource: 'rpc_error' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function walletStatus(args) {
    requireEmptyArgs(args);
    await walletReady;
    const address = (keystoreMode ? walletSigner : signer)?.address ?? null;
    let dailySpentJpyc = null;
    if (dailySpendStore !== null && address !== null) {
      try {
        const key = `${address.toLowerCase()}:${new Date().toISOString().slice(0, 10)}`;
        const spent = await dailySpendStore.load(key);
        if (typeof spent === 'string' && /^[0-9]+$/.test(spent)) {
          dailySpentJpyc = formatAtomicJpyc(BigInt(spent));
        }
      } catch {
        // Status remains readable when spend storage fails; payment still fails closed in the SDK.
      }
    }
    return {
      signerMode: kovaMode ? 'kova' : config.signerMode,
      address,
      walletError: walletFailure?.code ?? null,
      walletErrorMessage: walletFailure?.message ?? null,
      chain: 'polygon',
      ...await readBalance(address),
      limits: {
        perCallJpyc: formatAtomicJpyc(config.maxPerCallAtomic),
        sessionJpyc: formatAtomicJpyc(config.maxSessionAtomic),
        sessionSpentJpyc: formatAtomicJpyc(session.spentAtomic),
        dailyJpyc: config.maxDailyAtomic === null ? null : formatAtomicJpyc(config.maxDailyAtomic),
        dailySpentJpyc,
        dailyLimitSource,
      },
      allowedHosts: config.allowedHosts,
      catalogTrust: config.catalogTrust,
      fundingUrl: fundingUrl(address),
    };
  }

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

  // 人払いの内訳を返す (鍵不要・**支払いは発生しない**)。customerPaysJpyc/feeBearer を読む。
  // 通常は小計 (storefront は店が 1% を吸収) だが、preorder は顧客負担の 3% が上乗せされ得る。x402 の買い手上乗せ
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
    await walletReady;
    return paymentExecutor.quote(input.url);
  }

  // 掟 15: 決済状態の真実は facilitator の verify/settle とオンチェーンのみ。x402_pay の結果を読む
  // LLM は `status: 200` を「支払い済み」と解釈しがちなので、SDK が返す settlement を **その場の
  // 1 文で** 明示し、verified 以外を支払い証明として扱わせない。B9: `verified` も「discovery
  // origin が公開する署名鍵で領収書の署名が検証できた」だけで、オンチェーンの証明ではない。
  function settlementNote(settlement) {
    return `settlement: ${settlement} — verified only means the receipt signature is valid for the signer published by the discovery origin, not on-chain proof; treat unverified/receipt_unavailable as not proven paid`;
  }

  async function x402PayWithoutHistory(args) {
    const input = requireArgsObject(args);
    if (typeof input.url !== 'string') throw new Error('url is required');
    if (keystoreMode) {
      await walletReady;
      // SDK 0.9.0 only tests signer !== null; availability of this stable proxy is checked here.
      if (!signer.signerAvailable) {
        const reason = walletFailure?.code ?? 'wallet_not_initialized';
        return { ok: false, error: reason, reasons: [reason] };
      }
    }
    const result = await paymentExecutor.pay(input.url, {
      maxTotalJpyc: input.maxTotalJpyc,
    });
    // guard 拒否 (settlement を持たない quote 形) はそのまま返す — 支払いは発生していない。
    if (!isObject(result) || typeof result.settlement !== 'string') return result;
    return { ...result, settlementNote: settlementNote(result.settlement) };
  }

  let historyStarts = Promise.resolve();
  async function x402PayImpl(args) {
    // Awaited filesystem work must not reorder concurrent calls entering the SDK's existing
    // payment queue. Serialize only start admission; the SDK still owns payment serialization.
    const starting = historyStarts.then(async () => {
      await walletReady;
      return startPurchase({ env: walletEnv, url: args?.url, getPayer: () => signer?.address ?? null, deadlineMs: historyDeadlineMs });
    });
    historyStarts = starting.then(() => {}, () => {});
    const attempt = await starting;
    try {
      const result = await x402PayWithoutHistory(args);
      const history = await endPurchase({ env: walletEnv, attempt, result, deadlineMs: historyDeadlineMs });
      // 掟 12: 応答の形は変えない。オブジェクトのときだけ history を足す。
      return isObject(result) ? { ...result, history } : result;
    } catch (error) {
      // Ancillary history must not replace a payment exception; record unknown and rethrow it unchanged.
      await endPurchase({ env: walletEnv, attempt, threw: true, deadlineMs: historyDeadlineMs });
      throw error;
    }
  }

  function x402Pay(args) {
    return serializeWallet(() => x402PayImpl(args));
  }

  async function walletHistory(args) {
    const input = requireArgsObject(args);
    if (Array.isArray(input) || Object.keys(input).some((key) => key !== 'limit')) {
      throw new Error('wallet_history only accepts limit');
    }
    return readHistory({ env: walletEnv, limit: input.limit });
  }

  async function callTool(name, args) {
    if (knownToolNames.has(name) && !allowedToolNames.has(name)) {
      return textResult({ ok: false, error: 'tool_not_in_profile' }, true);
    }
    try {
      await walletReady;
      if (name === 'wallet_init') return textResult(await walletInit(args));
      if (name === 'wallet_status') return textResult(await walletStatus(args));
      if (name === 'wallet_history') return textResult(await walletHistory(args));
      if (name === 'wallet_prove') return textResult(await walletProve(args));
      if (name === 'discovery_search') return textResult(await discoverySearch(args));
      if (name === 'x402_quote') return textResult(await x402Quote(args));
      if (name === 'x402_pay') return textResult(await x402Pay(args));
      if (name === 'order_menu') return textResult(await orderMenu(args));
      if (name === 'order_quote') return textResult(await orderQuote(args));
      if (name === 'order_summary') return textResult(await orderSummary(args));
      if (name === 'createOrderLink') return textResult(await createOrderLink(args));
      if (name === 'find_shops') return textResult(await findShops(args));
      if (name === 'search_shops') return textResult(await searchShops(args));
      const unknownTool = `unknown tool: ${name}`;
      return textResult({ ok: false, error: keystoreMode ? errorMessage(unknownTool) : unknownTool }, true);
    } catch (error) {
      if (kovaMode && error instanceof Error && error.message === 'kova_policy_denied') {
        return textResult({ ok: false, error: 'kova_policy_denied', message: 'Kova の policy で拒否されました' }, true);
      }
      if (kovaMode && error instanceof Error && error.message === 'kova_not_found') {
        return textResult({ ok: false, error: 'kova_not_found', message: 'Kova CLI が見つかりません' }, true);
      }
      return textResult(
        { ok: false, error: errorMessage(error) },
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
    walletInit,
    walletStatus,
    walletHistory,
    walletProve,
  };
}
