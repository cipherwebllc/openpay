import {
  buildTypedDataFromPaymentRequirements,
  createAuthorization,
  decodePaymentResponse,
  encodePaymentPayload,
  paymentPayloadFor,
} from './payment.mjs';
import {
  evaluatePaymentGuards,
  recordSuccessfulPayment,
  safeErrorMessage,
} from './guards.mjs';

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

function sanitizedError(error, config) {
  return new Error(safeErrorMessage(error, config));
}

export function createPaymentExecutor({
  config,
  session,
  signer = null,
  signerAddress = signer?.address ?? null,
  spendStore = null,
  fetchImpl = fetch,
  nowSec = () => Math.floor(Date.now() / 1000),
  now = () => new Date(),
  resolveCatalogListings = async () => null,
}) {
  const dailyLimitEnabled =
    config.maxDailyAtomic !== null &&
    config.maxDailyAtomic !== undefined &&
    spendStore !== null;
  const guardConfig =
    !dailyLimitEnabled && config.maxDailyAtomic != null
      ? { ...config, maxDailyAtomic: null }
      : config;

  async function loadDailySpend() {
    if (!dailyLimitEnabled || typeof signerAddress !== 'string') {
      return { key: null, spentAtomic: null };
    }
    const current = now();
    const date = (current instanceof Date ? current : new Date(current))
      .toISOString()
      .slice(0, 10);
    const key = `${signerAddress.toLowerCase()}:${date}`;
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

  async function saveDailySpend(dailySpend, amountAtomic) {
    if (dailySpend.key === null || dailySpend.spentAtomic === null) return;
    try {
      await spendStore.save(
        dailySpend.key,
        (dailySpend.spentAtomic + amountAtomic).toString(),
      );
    } catch {
      // The unlock already succeeded; store failure must not replace the payment response.
    }
  }

  async function quoteImpl(url) {
    if (typeof url !== 'string') throw new Error('url is required');
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
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
    const guard = evaluatePaymentGuards({
      url,
      accept,
      config: guardConfig,
      sessionSpentAtomic: session.spentAtomic,
      dailySpentAtomic: dailySpend?.spentAtomic ?? null,
      catalogListings: await resolveCatalogListings(),
    });
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
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
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
    const guard = evaluatePaymentGuards({
      url,
      accept,
      config: guardConfig,
      sessionSpentAtomic: session.spentAtomic,
      dailySpentAtomic: dailySpend?.spentAtomic ?? null,
      maxTotalJpyc,
      requireMaxTotal: true,
      requireSigner: true,
      signerAvailable: signer !== null,
      catalogListings: await resolveCatalogListings(),
    });
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
    const unlocked = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'X-PAYMENT': encodePaymentPayload(paymentPayload),
      },
    });
    const unlockedBody = await readJson(unlocked);
    if (unlocked.status >= 200 && unlocked.status < 300) {
      recordSuccessfulPayment(session, guard.summary.totalAtomic);
      if (dailySpend !== null) {
        await saveDailySpend(dailySpend, guard.summary.totalAtomic);
      }
    }
    const receipt = decodePaymentResponse(
      unlocked.headers.get('x-payment-response'),
    );
    return {
      status: unlocked.status,
      body: unlockedBody,
      receipt,
    };
  }

  // Serialize the full read → sign → unlock → record path so concurrent calls cannot
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
