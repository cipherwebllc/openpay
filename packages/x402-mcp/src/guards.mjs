import { formatUnits, isHex } from 'viem';
import { normalizePaymentRequirements } from './payment.mjs';
import { readSignerMode, SIGNER_MODES } from './signer.mjs';

export const JPYC_DECIMALS = 18;
export const DEFAULT_MAX_PER_CALL_JPYC = '10';
export const DEFAULT_MAX_SESSION_JPYC = '100';
export const DEFAULT_ALLOWED_HOSTS = 'open-pay.jp';
// カタログ信頼 (既定 ON): OpenPay の審査済みカタログ (/api/discovery) に載っている URL への
// 支払いを、ALLOWED_HOSTS への手動追加なしで許可する。掲載は 402 ゲート実在 + OpenPay 方式
// (forwarder-split) の検証を通過したものだけで、金額の防御 (per-call/session/maxTotalJpyc) は
// 本設定と無関係に常に効く。CATALOG_TRUST=false で無効化できる。
export const DEFAULT_CATALOG_TRUST = true;
export const DEFAULT_DISCOVERY_URL = 'https://open-pay.jp/api/discovery';

export const REASONS = {
  invalidUrl: 'invalid_url',
  hostNotAllowed: 'host_not_allowed',
  unsupportedScheme: 'unsupported_scheme',
  unsupportedNetwork: 'unsupported_network',
  invalidOpenpayMode: 'invalid_openpay_mode',
  amountMismatch: 'amount_mismatch',
  invalidJpycAsset: 'invalid_jpyc_asset',
  resourceMismatch: 'resource_mismatch',
  invalidAccept: 'invalid_accept',
  maxTotalRequired: 'max_total_required',
  maxTotalInvalid: 'max_total_invalid',
  totalExceedsMaxTotal: 'total_exceeds_max_total',
  maxTotalAbovePerCallLimit: 'max_total_above_per_call_limit',
  perCallLimitExceeded: 'per_call_limit_exceeded',
  sessionLimitExceeded: 'session_limit_exceeded',
  buyerPrivateKeyMissing: 'buyer_private_key_missing',
  stewardSignerUnconfigured: 'steward_signer_unconfigured',
};

export const SUPPORTED_NETWORKS = new Set([
  'eip155:137',
  'eip155:80002',
  'eip155:8217',
  'eip155:1001',
  'eip155:43114',
  'eip155:43113',
]);

function nonEmpty(raw) {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function unique(values) {
  return [...new Set(values)];
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

export function parseJpycToAtomic(value, label) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^[0-9]+(?:\.[0-9]{1,18})?$/.test(raw)) {
    throw new Error(`${label} must be a JPYC decimal with up to 18 decimals`);
  }
  const [whole, fraction = ''] = raw.split('.');
  const atomic = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (atomic <= 0n) throw new Error(`${label} must be greater than 0`);
  return atomic;
}

export function formatAtomicJpyc(value) {
  return formatUnits(value, JPYC_DECIMALS);
}

function parseAllowedHosts(raw) {
  const source = nonEmpty(raw) ?? DEFAULT_ALLOWED_HOSTS;
  const hosts = source.split(',').map((part) => part.trim()).filter(Boolean);
  if (hosts.length === 0) throw new Error('ALLOWED_HOSTS must include at least one host');
  return unique(
    hosts.map((host) => {
      if (host.includes('://')) {
        throw new Error('ALLOWED_HOSTS entries must be bare hosts, not URLs');
      }
      let parsed;
      try {
        parsed = new URL(`http://${host}`);
      } catch {
        throw new Error(`ALLOWED_HOSTS entry is invalid: ${host}`);
      }
      if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error(`ALLOWED_HOSTS entry is invalid: ${host}`);
      }
      return parsed.hostname.toLowerCase();
    }),
  );
}

function parseOptionalPrivateKey(raw) {
  const key = nonEmpty(raw);
  if (key === undefined) return null;
  if (!isHex(key) || key.length !== 66) {
    throw new Error('BUYER_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string');
  }
  return key;
}

function parseHttpUrl(raw, label) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

function requireHttpUrl(raw, label) {
  const url = parseHttpUrl(raw, label);
  if (url === null) throw new Error(`${label} must be an http(s) URL`);
  return url.toString();
}

export function readMoneyConfig(env = process.env) {
  return {
    signerMode: readSignerMode(env),
    buyerPrivateKey: parseOptionalPrivateKey(env.BUYER_PRIVATE_KEY),
    stewardApiKey: nonEmpty(env.STEWARD_API_KEY) ?? null,
    stewardSignerSecret: nonEmpty(env.STEWARD_SIGNER_SECRET) ?? null,
    maxPerCallAtomic: parseJpycToAtomic(
      nonEmpty(env.MAX_PER_CALL_JPYC) ?? DEFAULT_MAX_PER_CALL_JPYC,
      'MAX_PER_CALL_JPYC',
    ),
    maxSessionAtomic: parseJpycToAtomic(
      nonEmpty(env.MAX_SESSION_JPYC) ?? DEFAULT_MAX_SESSION_JPYC,
      'MAX_SESSION_JPYC',
    ),
    allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
    catalogTrust:
      env.CATALOG_TRUST === undefined || env.CATALOG_TRUST === ''
        ? DEFAULT_CATALOG_TRUST
        : env.CATALOG_TRUST === 'true',
  };
}

export function readRuntimeConfig(env = process.env) {
  return {
    ...readMoneyConfig(env),
    discoveryUrl: requireHttpUrl(
      nonEmpty(env.DISCOVERY_URL) ?? DEFAULT_DISCOVERY_URL,
      'DISCOVERY_URL',
    ),
  };
}

export function createPaymentSession(initialSpentAtomic = 0n) {
  if (initialSpentAtomic < 0n) {
    throw new Error('initialSpentAtomic must be non-negative');
  }
  return { spentAtomic: initialSpentAtomic };
}

export function recordSuccessfulPayment(session, amountAtomic) {
  session.spentAtomic += amountAtomic;
  return session.spentAtomic;
}

export function isHostAllowed(url, allowedHosts) {
  const parsed = parseHttpUrl(url, 'url');
  if (parsed === null) return false;
  return allowedHosts.includes(parsed.hostname.toLowerCase());
}

function reasonFromNormalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('unsupported scheme')) return REASONS.unsupportedScheme;
  if (message.startsWith('unsupported network') || message === 'network must be a string') {
    return REASONS.unsupportedNetwork;
  }
  if (message === 'extra.openpay.forwarder-split is required') {
    return REASONS.invalidOpenpayMode;
  }
  if (message === 'maxAmountRequired must equal merchantValue + feeValue') {
    return REASONS.amountMismatch;
  }
  return REASONS.invalidAccept;
}

function addAssetReasons(reasons, rawAccept) {
  const extra = isObject(rawAccept) ? rawAccept.extra : undefined;
  if (
    !isObject(extra) ||
    extra.name !== 'JPY Coin' ||
    extra.decimals !== JPYC_DECIMALS
  ) {
    reasons.push(REASONS.invalidJpycAsset);
  }
}

function addResourceReason(reasons, rawAccept, requestUrl) {
  const requested = parseHttpUrl(requestUrl, 'url');
  const resource =
    isObject(rawAccept) && typeof rawAccept.resource === 'string'
      ? parseHttpUrl(rawAccept.resource, 'accept.resource')
      : null;
  if (
    requested === null ||
    resource === null ||
    resource.hostname.toLowerCase() !== requested.hostname.toLowerCase() ||
    resource.toString() !== requested.toString()
  ) {
    reasons.push(REASONS.resourceMismatch);
  }
}

export function summarizeAccept(accept) {
  const merchantValue = accept.extra.openpay.merchantValue;
  const feeValue = accept.extra.openpay.feeValue;
  const total = merchantValue + feeValue;
  return {
    priceAtomic: merchantValue,
    feeAtomic: feeValue,
    totalAtomic: total,
    priceJpyc: formatAtomicJpyc(merchantValue),
    feeJpyc: formatAtomicJpyc(feeValue),
    totalJpyc: formatAtomicJpyc(total),
    network: accept.network,
    asset: accept.asset,
    description: undefined,
  };
}

export function validateAcceptForPayment(rawAccept, requestUrl) {
  const reasons = [];
  let accept = null;
  let summary = null;

  try {
    accept = normalizePaymentRequirements(rawAccept);
    summary = summarizeAccept(accept);
  } catch (error) {
    reasons.push(reasonFromNormalizeError(error));
  }

  if (accept !== null && !SUPPORTED_NETWORKS.has(accept.network)) {
    reasons.push(REASONS.unsupportedNetwork);
  }
  addAssetReasons(reasons, rawAccept);
  addResourceReason(reasons, rawAccept, requestUrl);

  return {
    ok: reasons.length === 0,
    reasons: unique(reasons),
    accept,
    summary,
  };
}

function parseMaxTotalArg(value, reasons) {
  if (value === undefined || value === null) {
    reasons.push(REASONS.maxTotalRequired);
    return null;
  }
  try {
    return parseJpycToAtomic(value, 'maxTotalJpyc');
  } catch {
    reasons.push(REASONS.maxTotalInvalid);
    return null;
  }
}

export function evaluatePaymentGuards({
  url,
  accept,
  config,
  sessionSpentAtomic = 0n,
  maxTotalJpyc,
  requireMaxTotal = false,
  requirePrivateKey = false,
  requireSigner = false,
  signerAvailable = false,
  catalogUrls = null, // Set<string> | null。カタログ信頼用に呼び出し側が解決した掲載 URL 集合。
}) {
  const reasons = [];
  const parsedUrl = parseHttpUrl(url, 'url');
  if (parsedUrl === null) {
    reasons.push(REASONS.invalidUrl);
  } else {
    const hostAllowed = config.allowedHosts.includes(parsedUrl.hostname.toLowerCase());
    // カタログ信頼はホストでなく **URL 完全一致** — allowlist より狭い単位で許可する。
    const catalogListed =
      config.catalogTrust && catalogUrls instanceof Set && catalogUrls.has(parsedUrl.toString());
    if (!hostAllowed && !catalogListed) {
      reasons.push(REASONS.hostNotAllowed);
    }
  }

  const acceptValidation = validateAcceptForPayment(accept, url);
  reasons.push(...acceptValidation.reasons);

  let maxTotalAtomic = null;
  if (requireMaxTotal) {
    maxTotalAtomic = parseMaxTotalArg(maxTotalJpyc, reasons);
    if (maxTotalAtomic !== null && maxTotalAtomic > config.maxPerCallAtomic) {
      reasons.push(REASONS.maxTotalAbovePerCallLimit);
    }
  }

  if (acceptValidation.summary !== null) {
    const total = acceptValidation.summary.totalAtomic;
    if (maxTotalAtomic !== null && total > maxTotalAtomic) {
      reasons.push(REASONS.totalExceedsMaxTotal);
    }
    if (!requireMaxTotal && total > config.maxPerCallAtomic) {
      reasons.push(REASONS.perCallLimitExceeded);
    }
    if (sessionSpentAtomic + total > config.maxSessionAtomic) {
      reasons.push(REASONS.sessionLimitExceeded);
    }
  }

  if (requirePrivateKey || requireSigner) {
    if (config.signerMode === SIGNER_MODES.steward) {
      if (!signerAvailable) reasons.push(REASONS.stewardSignerUnconfigured);
    } else if (config.buyerPrivateKey === null) {
      reasons.push(REASONS.buyerPrivateKeyMissing);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons: unique(reasons),
    accept: acceptValidation.accept,
    summary: acceptValidation.summary,
  };
}

export function redactSensitiveText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('[redacted_private_key]');
    }
  }
  return out.replace(/\b0x[0-9a-fA-F]{130}\b/g, '[redacted_signature]');
}

export function safeErrorMessage(error, config = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message, [
    config.buyerPrivateKey,
    config.stewardApiKey,
    config.stewardSignerSecret,
  ]);
}
