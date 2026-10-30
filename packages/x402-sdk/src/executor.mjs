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

// Seller responses are read with a byte cap so a listed seller cannot fill the buyer's process
// memory: the 15-second request timeout alone still lets a fast link deliver hundreds of MB.
// Responses read before anything is signed (the 402 challenge) are small JSON documents.
export const MAX_CHALLENGE_BODY_BYTES = 256 * 1024;
// The response to the X-PAYMENT request is the purchased content, so its cap is larger and
// callers can change it with `maxPaidBodyBytes`.
export const DEFAULT_MAX_PAID_BODY_BYTES = 16 * 1024 * 1024;

const BODY_TOO_LARGE = Symbol('body_too_large');

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function parseJsonText(text) {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Returns the decoded text, or BODY_TOO_LARGE after cancelling the stream at the first chunk that
// crosses maxBytes. Bytes are counted from the stream itself; Content-Length may be absent or wrong.
async function readTextCapped(response, maxBytes) {
  const stream = response.body;
  if (typeof stream?.getReader !== 'function') {
    // A custom fetchImpl may hand back a body that is not a WHATWG stream (node-fetch's Node
    // stream, or an object with only text()). That transport is the caller's trusted boundary
    // (README), so it is read as before and only the size verdict is applied to it.
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? BODY_TOO_LARGE : text;
  }
  const reader = stream.getReader();
  // Same decoding as Response.text(): UTF-8, leading BOM removed, invalid bytes replaced.
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // With the default transport, cancel destroys the Node response behind Readable.toWeb and
      // with it the unfinished connection, so nothing past the cap is buffered.
      await reader.cancel();
      return BODY_TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function readChallengeJson(response) {
  const text = await readTextCapped(response, MAX_CHALLENGE_BODY_BYTES);
  // Nothing has been signed when the challenge is read, so refusing it costs the buyer nothing.
  if (text === BODY_TOO_LARGE) {
    throw new Error('payment_target_response_too_large');
  }
  return parseJsonText(text);
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

// Settlement truth for one paid call. HTTP 200 only means the seller returned a body; it is not
// evidence that the facilitator settled on chain, and an LLM reading `status: 200` will assume it is.
//   'verified'            — a receipt header was present and the facilitator signature bound it to this payment
//   'unverified'          — a receipt header was present but unsigned, malformed, forged, or mismatched
//   'receipt_unavailable' — no receipt header, or the facilitator signer could not be resolved
export const SETTLEMENT = Object.freeze({
  verified: 'verified',
  unverified: 'unverified',
  unavailable: 'receipt_unavailable',
});

async function settlementOutcome(
  raw,
  reservation,
  normalizedAccept,
  resolveReceiptSigner,
) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { receipt: null, settlement: SETTLEMENT.unavailable };
  }
  try {
    const decoded = decodePaymentResponse(raw);
    // A header that cannot be decoded is a seller claim we could not check, not an absent claim.
    if (decoded === null) {
      return { receipt: null, settlement: SETTLEMENT.unverified };
    }
    const expectedSigner = await resolveReceiptSigner();
    if (expectedSigner === null) {
      return { receipt: null, settlement: SETTLEMENT.unavailable };
    }
    const bound = await verifyBoundPaymentResponse(decoded, {
      expectedSigner,
      payer: reservation.payer,
      network: reservation.network,
      asset: reservation.asset,
      chainId: normalizedAccept.chainId,
      merchant: normalizedAccept.extra.openpay.merchant,
      merchantValue: normalizedAccept.extra.openpay.merchantValue,
      feeValue: normalizedAccept.extra.openpay.feeValue,
      nonce: reservation.id,
    });
    return bound
      ? { receipt: decoded, settlement: SETTLEMENT.verified }
      : { receipt: null, settlement: SETTLEMENT.unverified };
  } catch {
    // A seller-controlled receipt header must not erase an unlocked body and invite a duplicate payment.
    return { receipt: null, settlement: SETTLEMENT.unverified };
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
  maxPaidBodyBytes = DEFAULT_MAX_PAID_BODY_BYTES,
}) {
  if (!Number.isSafeInteger(maxPaidBodyBytes) || maxPaidBodyBytes <= 0) {
    throw new Error('maxPaidBodyBytes must be a positive integer');
  }
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
    const body = await readChallengeJson(response);
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
    const body = await readChallengeJson(response);
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
    const unlockedText = await readTextCapped(unlocked, maxPaidBodyBytes);
    const unlockedBody =
      unlockedText === BODY_TOO_LARGE ? null : parseJsonText(unlockedText);
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
    const { receipt, settlement } = await settlementOutcome(
      unlocked.headers.get('x-payment-response'),
      reservation,
      normalizedAccept,
      resolveReceiptSigner,
    );
    if (unlockedText === BODY_TOO_LARGE) {
      // The authorization has already left this process, so an oversized body must not read as a
      // failed purchase: keep the settlement and the identifiers the buyer needs before paying again.
      return {
        status: unlocked.status,
        body: null,
        receipt,
        settlement,
        error: 'paid_body_too_large',
        maxPaidBodyBytes,
        txHash: settlement === SETTLEMENT.verified ? receipt.transaction : null,
        authorizationNonce: reservation.id,
        note: `The payment authorization was sent, but the seller's response exceeded maxPaidBodyBytes (${maxPaidBodyBytes}) and was discarded. Check settlement, txHash or the authorization nonce on chain before paying again.`,
      };
    }
    return {
      status: unlocked.status,
      body: unlockedBody,
      receipt,
      settlement,
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
