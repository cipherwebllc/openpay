import { formatUnits, isHex } from 'viem';
import {
  MAX_AUTHORIZATION_TIMEOUT_SECONDS,
  normalizePaymentRequirements,
} from './payment.mjs';
import {
  parseSignerOptions,
  readSignerMode,
  SIGNER_MODES,
} from './signer.mjs';

export const JPYC_DECIMALS = 18;
export const DEFAULT_MAX_PER_CALL_JPYC = '10';
export const DEFAULT_MAX_SESSION_JPYC = '100';
export const DEFAULT_MAX_TIMEOUT_SECONDS = 600;
// OpenPay facilitator の有効期限上限 (20分) より長い authorization を設定で
// 許可すると、売り手が facilitator を迂回して後日直接 settle できる波及を残す。
export const MAX_SUPPORTED_TIMEOUT_SECONDS = MAX_AUTHORIZATION_TIMEOUT_SECONDS;
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
  invalidOpenpayForwarder: 'invalid_openpay_forwarder',
  amountMismatch: 'amount_mismatch',
  invalidJpycAsset: 'invalid_jpyc_asset',
  timeoutTooLong: 'timeout_too_long',
  resourceMismatch: 'resource_mismatch',
  invalidAccept: 'invalid_accept',
  maxTotalRequired: 'max_total_required',
  maxTotalInvalid: 'max_total_invalid',
  totalExceedsMaxTotal: 'total_exceeds_max_total',
  maxTotalAbovePerCallLimit: 'max_total_above_per_call_limit',
  perCallLimitExceeded: 'per_call_limit_exceeded',
  sessionLimitExceeded: 'session_limit_exceeded',
  dailyLimitExceeded: 'daily_limit_exceeded',
  dailySpendUnavailable: 'daily_spend_unavailable',
  dailyAuthorizationCrossesUtcDay: 'daily_authorization_crosses_utc_day',
  buyerPrivateKeyMissing: 'buyer_private_key_missing',
  stewardSignerUnconfigured: 'steward_signer_unconfigured',
  // catalog trust 経由 (第三者ドメイン) の URL で、支払い時にライブ fetch した accept が
  // discovery 掲載 accept (OpenPay サーバー生成の権威値) と食い違う = bait-and-switch。
  catalogAcceptMismatch: 'catalog_accept_mismatch',
};

const JPYC_V3_ADDRESS = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const JPYC_V3_DEFINITION = Object.freeze({
  address: JPYC_V3_ADDRESS,
  name: 'JPY Coin',
  version: '1',
  decimals: JPYC_DECIMALS,
});

// Buyer が署名してよい JPYC v3 domain の単一情報源。asset と自己申告 metadata を
// network ごとの既知値へ束縛し、allowlist 済み売り手が別 token の署名を得る波及を断つ。
export const SUPPORTED_JPYC_ASSETS = Object.freeze({
  'eip155:137': JPYC_V3_DEFINITION,
  'eip155:80002': JPYC_V3_DEFINITION,
  'eip155:8217': JPYC_V3_DEFINITION,
  'eip155:1001': JPYC_V3_DEFINITION,
  'eip155:43114': JPYC_V3_DEFINITION,
  'eip155:43113': JPYC_V3_DEFINITION,
});

export const SUPPORTED_NETWORKS = new Set(Object.keys(SUPPORTED_JPYC_ASSETS));

// OpenPay が deploy 済みとして公開している Eip3009Forwarder。未掲載 chain の
// forwarder は審査済み catalog accept との完全一致が取れた場合だけ許可する。
// ホスト allowlist だけで署名の `to` を攻撃者 EOA へ差し替え、表示した分配を
// 迂回して総額を直接受領する波及を断つ。
export const SUPPORTED_JPYC_FORWARDERS = Object.freeze({
  'eip155:137': '0x0F4560a777415580F0680F8B56a79B0022C6B848',
  'eip155:80002': '0x752B7AaD0089286EB7b553d84D05233d80c9FCB4',
});

function nonEmpty(raw) {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function unique(values) {
  return [...new Set(values)];
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function parseMaxTimeoutSeconds(value, label) {
  const parsed =
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_SUPPORTED_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `${label} must be an integer between 1 and ${MAX_SUPPORTED_TIMEOUT_SECONDS}`,
    );
  }
  return parsed;
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

// DISCOVERY_URL は catalog trust の権威 (ここに載る URL は ALLOWED_HOSTS への手動追加なしで
// 支払える)。平文 http はネットワーク上で差し替え可能なので、攻撃者のカタログが「審査済み」に
// 化けて支払い先を乗っ取る波及を断つため https に限る。例外はローカル開発 (localhost /
// 127.0.0.1) のみ — 自機の facilitator/カタログを立てて配線を確かめる用途。
function requireDiscoveryUrl(raw, label) {
  const url = parseHttpUrl(raw, label);
  if (url === null) throw new Error(`${label} must be an http(s) URL`);
  if (
    url.protocol === 'http:' &&
    url.hostname !== 'localhost' &&
    url.hostname !== '127.0.0.1'
  ) {
    throw new Error(`${label} must use https (http is allowed only for localhost)`);
  }
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
    maxTimeoutSeconds: parseMaxTimeoutSeconds(
      nonEmpty(env.MAX_TIMEOUT_SECONDS) ?? DEFAULT_MAX_TIMEOUT_SECONDS,
      'MAX_TIMEOUT_SECONDS',
    ),
    maxDailyAtomic:
      nonEmpty(env.MAX_DAILY_JPYC) === undefined
        ? null
        : parseJpycToAtomic(env.MAX_DAILY_JPYC, 'MAX_DAILY_JPYC'),
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
    discoveryUrl: requireDiscoveryUrl(
      nonEmpty(env.DISCOVERY_URL) ?? DEFAULT_DISCOVERY_URL,
      'DISCOVERY_URL',
    ),
  };
}

function optionAmount(value, fallback) {
  return value === undefined || value === '' ? fallback : value;
}

export function parseClientOptions(options = {}) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('client options must be an object');
  }
  const parsedSigner = parseSignerOptions(options);
  if (
    options.allowedHosts !== undefined &&
    typeof options.allowedHosts !== 'string'
  ) {
    throw new Error('ALLOWED_HOSTS must be a comma-separated string');
  }
  if (
    options.catalogTrust !== undefined &&
    typeof options.catalogTrust !== 'boolean'
  ) {
    throw new Error('catalogTrust must be a boolean');
  }

  return {
    signerMode:
      parsedSigner.kind === 'steward' || parsedSigner.kind === 'custom'
        ? SIGNER_MODES.steward
        : SIGNER_MODES.envKey,
    buyerPrivateKey:
      parsedSigner.kind === 'private-key' ? parsedSigner.privateKey : null,
    stewardApiKey:
      parsedSigner.kind === 'steward' ? parsedSigner.config.apiKey : null,
    stewardSignerSecret:
      parsedSigner.kind === 'steward' ? parsedSigner.config.signerSecret : null,
    maxPerCallAtomic: parseJpycToAtomic(
      optionAmount(options.maxPerCallJpyc, DEFAULT_MAX_PER_CALL_JPYC),
      'MAX_PER_CALL_JPYC',
    ),
    maxSessionAtomic: parseJpycToAtomic(
      optionAmount(options.maxSessionJpyc, DEFAULT_MAX_SESSION_JPYC),
      'MAX_SESSION_JPYC',
    ),
    maxTimeoutSeconds: parseMaxTimeoutSeconds(
      optionAmount(options.maxTimeoutSeconds, DEFAULT_MAX_TIMEOUT_SECONDS),
      'maxTimeoutSeconds',
    ),
    maxDailyAtomic:
      options.maxDailyJpyc === undefined || options.maxDailyJpyc === ''
        ? null
        : parseJpycToAtomic(options.maxDailyJpyc, 'MAX_DAILY_JPYC'),
    allowedHosts: parseAllowedHosts(options.allowedHosts),
    catalogTrust: options.catalogTrust ?? DEFAULT_CATALOG_TRUST,
    discoveryUrl: requireDiscoveryUrl(
      nonEmpty(options.discoveryUrl) ?? DEFAULT_DISCOVERY_URL,
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

function addAssetReasons(reasons, rawAccept, accept) {
  const extra = isObject(rawAccept) ? rawAccept.extra : undefined;
  const expected =
    accept === null ? undefined : SUPPORTED_JPYC_ASSETS[accept.network];
  if (
    expected === undefined ||
    accept.asset !== expected.address ||
    !isObject(extra) ||
    extra.name !== expected.name ||
    extra.version !== expected.version ||
    extra.decimals !== expected.decimals
  ) {
    reasons.push(REASONS.invalidJpycAsset);
  }
}

// クエリの正準比較: URLSearchParams でデコードした (key, value) 列の順序付き一致。
// Vercel/Next 系ホストは request.url の時点でスペースを `+` に正規化するため (`%20` の原文は
// サーバー側で復元不可能)、accept.resource と要求 URL のバイト一致要求は正当な売り手を
// 恒常的に落とす (gateway.open-pay.jp で実害)。`%20` と `+` は form-urlencoding で同一の
// スペースにデコードされる一方、`%2B` (リテラル +) や二重エンコードは異なる値にデコード
// されるので、この比較は同義エンコーディングだけを同一視し resource 束縛は緩めない。
function sameQuery(a, b) {
  const ap = [...a.searchParams];
  const bp = [...b.searchParams];
  if (ap.length !== bp.length) return false;
  return ap.every(([k, v], i) => bp[i][0] === k && bp[i][1] === v);
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
    resource.origin !== requested.origin ||
    resource.pathname !== requested.pathname ||
    resource.username !== requested.username ||
    resource.password !== requested.password ||
    !sameQuery(resource, requested)
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
  addAssetReasons(reasons, rawAccept, accept);
  addResourceReason(reasons, rawAccept, requestUrl);

  return {
    ok: reasons.length === 0,
    reasons: unique(reasons),
    accept,
    summary,
  };
}

// catalog trust の掲載 accept (discovery = OpenPay サーバー権威) とライブ accept が、金銭に効く
// 全フィールド (asset/有効期限/forwarder/受取先/各金額/commit) まで一致するかを照合する。第三者ドメインが
// 掲載時と別の forwarder/asset を bait-and-switch して buyer に攻撃者宛の署名を作らせる P0 を塞ぐ。
// どちらかが正規化不能なら不一致 (fail-close)。
function catalogAcceptConsistent(liveRawAccept, listedRawAccept) {
  try {
    const a = normalizePaymentRequirements(liveRawAccept);
    const b = normalizePaymentRequirements(listedRawAccept);
    return (
      a.network === b.network &&
      a.asset === b.asset &&
      a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
      a.extra.openpay.forwarder === b.extra.openpay.forwarder &&
      a.extra.openpay.merchant === b.extra.openpay.merchant &&
      a.extra.openpay.merchantValue === b.extra.openpay.merchantValue &&
      a.extra.openpay.feeReceiver === b.extra.openpay.feeReceiver &&
      a.extra.openpay.feeValue === b.extra.openpay.feeValue &&
      a.extra.openpay.commitVersion === b.extra.openpay.commitVersion
    );
  } catch {
    return false;
  }
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
  dailySpentAtomic = null,
  maxTotalJpyc,
  requireMaxTotal = false,
  requirePrivateKey = false,
  requireSigner = false,
  signerAvailable = false,
  // Map<string, rawAccept> | null。カタログ信頼用に呼び出し側が解決した「掲載 URL → 掲載 accept
  // (OpenPay サーバー生成の権威値)」。URL 一致で支払いを許可し、accept を bait-and-switch 照合に使う。
  catalogListings = null,
}) {
  const reasons = [];
  const maxDailyAtomic = config.maxDailyAtomic ?? null;
  const configuredMaxTimeoutSeconds =
    config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  // 公開 primitive では config を手組みできるため、parser を迂回した不正な上限値が
  // authorization の絶対上限を広げる波及を断ち、無効値は 0 扱いで fail-close する。
  const maxTimeoutSeconds =
    Number.isSafeInteger(configuredMaxTimeoutSeconds) &&
    configuredMaxTimeoutSeconds > 0
      ? Math.min(
          configuredMaxTimeoutSeconds,
          MAX_SUPPORTED_TIMEOUT_SECONDS,
        )
      : 0;
  const parsedUrl = parseHttpUrl(url, 'url');
  let catalogAcceptMatches = false;
  if (parsedUrl === null) {
    reasons.push(REASONS.invalidUrl);
  } else {
    const hostAllowed = config.allowedHosts.includes(parsedUrl.hostname.toLowerCase());
    // catalog admission は完全一致だけ。query-free 掲載を任意 query へ広げると、
    // GET 副作用を持つ未審査 URL へ buyer を到達させる波及が残る。
    let listedAccept;
    if (config.catalogTrust && catalogListings instanceof Map) {
      listedAccept = catalogListings.get(parsedUrl.toString());
    }
    const catalogListed = listedAccept !== undefined;
    catalogAcceptMatches =
      catalogListed && catalogAcceptConsistent(accept, listedAccept);
    if (!hostAllowed && !catalogListed) {
      reasons.push(REASONS.hostNotAllowed);
    } else if (!hostAllowed && catalogListed) {
      // ALLOWED_HOSTS 直 (open-pay.jp) はサーバー権威ゆえ照合不要。catalog trust 経由 (第三者
      // ドメイン) でのみ、ライブ accept が掲載 accept と金銭フィールドまで一致するか照合する。
      if (!catalogAcceptMatches) {
        reasons.push(REASONS.catalogAcceptMismatch);
      }
    }
  }

  const acceptValidation = validateAcceptForPayment(accept, url);
  reasons.push(...acceptValidation.reasons);
  if (acceptValidation.accept !== null) {
    const knownForwarder =
      SUPPORTED_JPYC_FORWARDERS[acceptValidation.accept.network];
    if (
      acceptValidation.accept.extra.openpay.forwarder !== knownForwarder &&
      !catalogAcceptMatches
    ) {
      reasons.push(REASONS.invalidOpenpayForwarder);
    }
  }

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
    if (
      maxDailyAtomic !== null &&
      dailySpentAtomic !== null &&
      dailySpentAtomic + total > maxDailyAtomic
    ) {
      reasons.push(REASONS.dailyLimitExceeded);
    }
  }

  if (
    acceptValidation.accept !== null &&
    acceptValidation.accept.maxTimeoutSeconds > maxTimeoutSeconds
  ) {
    reasons.push(REASONS.timeoutTooLong);
  }

  if (maxDailyAtomic !== null && dailySpentAtomic === null) {
    reasons.push(REASONS.dailySpendUnavailable);
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
