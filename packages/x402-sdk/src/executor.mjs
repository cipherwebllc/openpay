import {
  buildTypedDataFromPaymentRequirements,
  createAuthorization,
  decodePaymentResponse,
  encodePaymentPayload,
  paymentPayloadFor,
} from './payment.mjs';
import {
  evaluatePaymentGuards,
  REASONS,
  recordSuccessfulPayment,
  safeErrorMessage,
} from './guards.mjs';
import {
  DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  fetchPaymentTarget,
  parseSafePaymentUrl,
} from './network.mjs';
import { verifyBoundPaymentResponse } from './receipt.mjs';

const sessionReservations = new WeakMap();

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

function firstAccept(body) {
  if (!isObject(body) || !Array.isArray(body.accepts) || body.accepts.length === 0) {
    return null;
  }
  return body.accepts[0];
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

function rejectedQuote(url, status, guard, reason) {
  return quoteShape(url, status, {
    ...guard,
    ok: false,
    reasons: [...new Set([...guard.reasons, reason])],
  });
}

function sanitizedError(error, config) {
  return new Error(safeErrorMessage(error, config));
}

function reservationLedger(session) {
  let ledger = sessionReservations.get(session);
  if (ledger === undefined) {
    ledger = new Map();
    sessionReservations.set(session, ledger);
  }
  return ledger;
}

function sessionPendingAtomic(session) {
  let total = 0n;
  for (const reservation of reservationLedger(session).values()) {
    total += reservation.amountAtomic;
  }
  return total;
}

function reserveSession(session, reservation, maxSessionAtomic) {
  const ledger = reservationLedger(session);
  const existing = ledger.get(reservation.id);
  if (existing !== undefined) {
    return (
      existing.amountAtomic === reservation.amountAtomic &&
      existing.validBefore === reservation.validBefore
    );
  }
  if (
    session.spentAtomic +
      sessionPendingAtomic(session) +
      reservation.amountAtomic >
    maxSessionAtomic
  ) {
    return false;
  }
  ledger.set(reservation.id, reservation);
  return true;
}

function cancelUnsentSessionReservation(session, id) {
  reservationLedger(session).delete(id);
}

function confirmSessionReservation(session, id, amountAtomic) {
  recordSuccessfulPayment(session, amountAtomic);
  reservationLedger(session).delete(id);
}

function catalogAcceptForUrl(parsedUrl, catalogListings) {
  if (!(catalogListings instanceof Map)) return undefined;
  return catalogListings.get(parsedUrl.toString());
}

function utcDate(value) {
  const instant = value instanceof Date ? value : new Date(value);
  const timestamp = instant.getTime();
  if (!Number.isFinite(timestamp)) return null;
  return instant.toISOString().slice(0, 10);
}

async function safeReceipt(
  raw,
  reservation,
  normalizedAccept,
  resolveReceiptSigner,
) {
  try {
    const decoded = decodePaymentResponse(raw);
    if (decoded === null) return null;
    const expectedSigner = await resolveReceiptSigner();
    if (
      expectedSigner === null ||
      !(await verifyBoundPaymentResponse(decoded, {
        expectedSigner,
        payer: reservation.payer,
        network: reservation.network,
        asset: reservation.asset,
        chainId: normalizedAccept.chainId,
        merchant: normalizedAccept.extra.openpay.merchant,
        merchantValue: normalizedAccept.extra.openpay.merchantValue,
        feeValue: normalizedAccept.extra.openpay.feeValue,
        nonce: reservation.id,
      }))
    ) {
      return null;
    }
    return decoded;
  } catch {
    // A seller-controlled receipt header must not erase an unlocked body and invite a duplicate payment.
    return null;
  }
}

export function createPaymentExecutor({
  config,
  session,
  signer = null,
  signerAddress = signer?.address ?? null,
  spendStore = null,
  fetchImpl = fetch,
  lookup,
  requestTimeoutMs = DEFAULT_PAYMENT_FETCH_TIMEOUT_MS,
  nowSec = () => Math.floor(Date.now() / 1000),
  now = () => new Date(),
  resolveCatalogListings = async () => null,
  resolveReceiptSigner = async () => null,
}) {
  const dailyLimitEnabled =
    config.maxDailyAtomic !== null && config.maxDailyAtomic !== undefined;
  if (dailyLimitEnabled && spendStore === null) {
    throw new Error(
      'spendStore is required when maxDailyAtomic is configured',
    );
  }

  function currentSessionExposure() {
    return session.spentAtomic + sessionPendingAtomic(session);
  }

  function currentDailyKey() {
    if (!dailyLimitEnabled || typeof signerAddress !== 'string') return null;
    const date = utcDate(now());
    return date === null
      ? null
      : `${signerAddress.toLowerCase()}:${date}`;
  }

  async function loadDailySpend() {
    const key = currentDailyKey();
    if (key === null) return { key: null, spentAtomic: null };
    try {
      const stored = await spendStore.load(key);
      if (typeof stored !== 'string' || !/^[0-9]+$/.test(stored)) {
        return { key, spentAtomic: null };
      }
      return { key, spentAtomic: BigInt(stored) };
    } catch {
      return { key, spentAtomic: null };
    }
  }

  async function reserveDailySpend(dailySpend, amountAtomic, reservation) {
    if (dailySpend.key === null || dailySpend.spentAtomic === null) {
      return { ok: false, reason: 'unavailable' };
    }
    if (typeof spendStore.reserve === 'function') {
      try {
        const result = await spendStore.reserve(
          dailySpend.key,
          amountAtomic.toString(),
          config.maxDailyAtomic.toString(),
          reservation,
        );
        if (
          !isObject(result) ||
          (result.ok !== true && result.ok !== false)
        ) {
          return { ok: false, reason: 'unavailable' };
        }
        if (result.ok === false) {
          return result.reason === 'limit_exceeded'
            ? result
            : { ok: false, reason: 'unavailable' };
        }
        if (
          typeof result.totalAtomic !== 'string' ||
          !/^[0-9]+$/.test(result.totalAtomic)
        ) {
          return { ok: false, reason: 'unavailable' };
        }
        const totalAtomic = BigInt(result.totalAtomic);
        if (
          totalAtomic < dailySpend.spentAtomic + amountAtomic ||
          totalAtomic > config.maxDailyAtomic
        ) {
          return { ok: false, reason: 'unavailable' };
        }
        return result;
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    }

    // Legacy custom stores remain callable, but a write is verified before exposing the signature.
    try {
      const fresh = await spendStore.load(dailySpend.key);
      if (typeof fresh !== 'string' || !/^[0-9]+$/.test(fresh)) {
        return { ok: false, reason: 'unavailable' };
      }
      const next = BigInt(fresh) + amountAtomic;
      if (next > config.maxDailyAtomic) {
        return {
          ok: false,
          reason: 'limit_exceeded',
          totalAtomic: fresh,
        };
      }
      await spendStore.save(dailySpend.key, next.toString());
      const persisted = await spendStore.load(dailySpend.key);
      if (
        typeof persisted !== 'string' ||
        !/^[0-9]+$/.test(persisted) ||
        BigInt(persisted) < next
      ) {
        return { ok: false, reason: 'unavailable' };
      }
      return { ok: true, totalAtomic: persisted };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  async function confirmDailyReservation(id) {
    if (typeof spendStore?.confirm !== 'function') return;
    try {
      await spendStore.confirm(id);
    } catch {
      // Confirmation metadata is ancillary; its failure must not replace a completed unlock response.
    }
  }

  async function targetAccess(url) {
    const parsedUrl = parseSafePaymentUrl(url);
    if (parsedUrl === null) {
      return {
        ok: false,
        parsedUrl: null,
        catalogListings: null,
        reasons: [REASONS.invalidUrl],
      };
    }
    const hostAllowed = config.allowedHosts.includes(
      parsedUrl.hostname.toLowerCase(),
    );
    let catalogListings = null;
    let catalogListed = false;
    if (!hostAllowed && config.catalogTrust) {
      catalogListings = await resolveCatalogListings();
      catalogListed =
        catalogAcceptForUrl(parsedUrl, catalogListings) !== undefined;
    }
    const reasons = [];
    if (!hostAllowed && !catalogListed) reasons.push(REASONS.hostNotAllowed);
    if (parsedUrl.protocol !== 'https:') {
      reasons.push(REASONS.unsupportedScheme);
    }
    return {
      ok: reasons.length === 0,
      parsedUrl,
      catalogListings,
      reasons,
    };
  }

  function fetchTarget(url, headers) {
    return fetchPaymentTarget(url, {
      fetchImpl,
      headers,
      lookup,
      timeoutMs: requestTimeoutMs,
    });
  }

  async function withForwarderCatalogFallback(guardInput, catalogListings) {
    let guard = evaluatePaymentGuards({
      ...guardInput,
      catalogListings,
    });
    if (
      catalogListings === null &&
      config.catalogTrust &&
      guard.reasons.includes(REASONS.invalidOpenpayForwarder)
    ) {
      const resolved = await resolveCatalogListings();
      guard = evaluatePaymentGuards({
        ...guardInput,
        catalogListings: resolved,
      });
      return { guard, catalogListings: resolved };
    }
    return { guard, catalogListings };
  }

  async function quoteImpl(url) {
    if (typeof url !== 'string') throw new Error('url is required');
    const access = await targetAccess(url);
    if (!access.ok) {
      return quoteShape(url, 0, {
        ok: false,
        reasons: access.reasons,
        summary: null,
      });
    }
    const response = await fetchTarget(url, {
      accept: 'application/json',
    });
    const body = await readJson(response);
    const accept = firstAccept(body);
    if (response.status !== 402 || accept === null) {
      return {
        url,
        status: response.status,
        ok: false,
        reasons: ['expected_402_with_accepts'],
      };
    }
    const dailySpend = dailyLimitEnabled ? await loadDailySpend() : null;
    const { guard } = await withForwarderCatalogFallback(
      {
        url,
        accept,
        config,
        sessionSpentAtomic: currentSessionExposure(),
        dailySpentAtomic: dailySpend?.spentAtomic ?? null,
      },
      access.catalogListings,
    );
    return quoteShape(url, response.status, guard);
  }

  async function quote(url) {
    try {
      return await quoteImpl(url);
    } catch (error) {
      throw sanitizedError(error, config);
    }
  }

  async function payImpl(url, { maxTotalJpyc } = {}) {
    if (typeof url !== 'string') throw new Error('url is required');
    const access = await targetAccess(url);
    if (!access.ok) {
      return quoteShape(url, 0, {
        ok: false,
        reasons: access.reasons,
        summary: null,
      });
    }
    const response = await fetchTarget(url, {
      accept: 'application/json',
    });
    const body = await readJson(response);
    const accept = firstAccept(body);
    if (response.status !== 402 || accept === null) {
      return {
        url,
        status: response.status,
        ok: false,
        reasons: ['expected_402_with_accepts'],
      };
    }
    let dailySpend = dailyLimitEnabled ? await loadDailySpend() : null;
    const initialGuard = await withForwarderCatalogFallback(
      {
        url,
        accept,
        config,
        sessionSpentAtomic: currentSessionExposure(),
        dailySpentAtomic: dailySpend?.spentAtomic ?? null,
        maxTotalJpyc,
        requireMaxTotal: true,
        requireSigner: true,
        signerAvailable: signer !== null,
      },
      access.catalogListings,
    );
    let guard = initialGuard.guard;
    const catalogListings = initialGuard.catalogListings;
    if (!guard.ok) return quoteShape(url, response.status, guard);

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
    const reservation = {
      id: typedData.message.nonce,
      amountAtomic: guard.summary.totalAtomic,
      payer: typedData.message.from,
      network: normalizedAccept.network,
      asset: normalizedAccept.asset,
      validBefore: authorization.validBefore,
    };

    // Re-read all mutable counters after the last pre-sign await. A UTC rollover or
    // another process reservation must be visible before this authorization leaves.
    dailySpend = dailyLimitEnabled ? await loadDailySpend() : null;
    guard = evaluatePaymentGuards({
      url,
      accept,
      config,
      sessionSpentAtomic: currentSessionExposure(),
      dailySpentAtomic: dailySpend?.spentAtomic ?? null,
      maxTotalJpyc,
      requireMaxTotal: true,
      requireSigner: true,
      signerAvailable: signer !== null,
      catalogListings,
    });
    if (!guard.ok) return quoteShape(url, response.status, guard);

    if (
      dailyLimitEnabled &&
      (dailySpend?.key === null ||
        utcDate(Number(authorization.validBefore) * 1000) !==
          dailySpend.key.slice(-10))
    ) {
      return rejectedQuote(
        url,
        response.status,
        guard,
        REASONS.dailyAuthorizationCrossesUtcDay,
      );
    }

    if (!reserveSession(session, reservation, config.maxSessionAtomic)) {
      return rejectedQuote(
        url,
        response.status,
        guard,
        REASONS.sessionLimitExceeded,
      );
    }
    if (dailyLimitEnabled) {
      const reserved = await reserveDailySpend(
        dailySpend,
        guard.summary.totalAtomic,
        reservation,
      );
      if (!reserved.ok) {
        // This signature has not crossed a process boundary, so only this unsent reservation is safe to release.
        cancelUnsentSessionReservation(session, reservation.id);
        return rejectedQuote(
          url,
          response.status,
          guard,
          reserved.reason === 'limit_exceeded'
            ? REASONS.dailyLimitExceeded
            : REASONS.dailySpendUnavailable,
        );
      }
    }

    const unlocked = await fetchTarget(url, {
      accept: 'application/json',
      'X-PAYMENT': encodePaymentPayload(paymentPayload),
    });
    const unlockedBody = await readJson(unlocked);
    if (unlocked.status >= 200 && unlocked.status < 300) {
      confirmSessionReservation(
        session,
        reservation.id,
        guard.summary.totalAtomic,
      );
      if (dailyLimitEnabled) {
        await confirmDailyReservation(reservation.id);
      }
    }
    const receipt = await safeReceipt(
      unlocked.headers.get('x-payment-response'),
      reservation,
      normalizedAccept,
      resolveReceiptSigner,
    );
    return {
      status: unlocked.status,
      body: unlockedBody,
      receipt,
    };
  }

  // Serialize the full read → sign → reserve → unlock → record path so concurrent calls cannot
  // observe the same pre-payment session total and exceed the cumulative cap.
  let payChain = Promise.resolve();
  async function pay(url, options) {
    const execute = async () => {
      try {
        return await payImpl(url, options);
      } catch (error) {
        throw sanitizedError(error, config);
      }
    };
    const run = payChain.then(execute, execute);
    // A failed payment must not prevent later independent payments from entering the queue.
    payChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  return { quote, pay };
}
