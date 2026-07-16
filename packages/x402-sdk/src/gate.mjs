const DEFAULT_OPENPAY_ORIGIN = 'https://open-pay.jp';
const ACCEPTS_CACHE_MS = 5 * 60_000;

function json402(accepts, error) {
  return new Response(JSON.stringify({ x402Version: 1, accepts, error }), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });
}

function decodeBase64Json(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeBase64Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createJpycGate({
  resourceUrl,
  openpayOrigin = DEFAULT_OPENPAY_ORIGIN,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  const origin = openpayOrigin.replace(/\/+$/, '');
  let acceptsCache = null;
  let acceptsCachedAt = 0;

  async function catalogAccepts() {
    if (
      acceptsCache !== null &&
      now() - acceptsCachedAt < ACCEPTS_CACHE_MS
    ) {
      return acceptsCache;
    }

    const response = await fetchImpl(`${origin}/api/discovery`);
    const { items } = await response.json();
    const mine = (items || []).find((item) => item.resource === resourceUrl);
    if (!mine || !mine.accepts || mine.accepts.length === 0) {
      throw new Error(`resource not found in OpenPay catalog: ${resourceUrl}`);
    }
    acceptsCache = mine.accepts;
    acceptsCachedAt = now();
    return acceptsCache;
  }

  async function facilitator(path, paymentPayload, paymentRequirements) {
    const response = await fetchImpl(`${origin}/api/facilitator/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
      }),
    });
    return response.json();
  }

  async function verify(request) {
    const accepts = (await catalogAccepts()).map((accept) => ({
      ...accept,
      resource: request.url,
    }));
    const header = request.headers.get('x-payment');
    if (!header) return json402(accepts, 'payment_required');

    let paymentPayload;
    try {
      paymentPayload = decodeBase64Json(header);
    } catch {
      return json402(accepts, 'invalid_payment_payload');
    }

    const paymentRequirements = accepts[0];
    const verification = await facilitator(
      'verify',
      paymentPayload,
      paymentRequirements,
    );
    if (verification.isValid !== true) {
      return json402(
        accepts,
        verification.invalidReason || 'payment_invalid',
      );
    }

    return {
      async settle() {
        const settlement = await facilitator(
          'settle',
          paymentPayload,
          paymentRequirements,
        );
        if (settlement.success !== true) {
          return json402(
            accepts,
            settlement.errorReason || 'settlement_failed',
          );
        }
        return { paymentResponseHeader: encodeBase64Json(settlement) };
      },
    };
  }

  async function handle(request) {
    const verification = await verify(request);
    if (verification instanceof Response) return verification;
    return verification.settle();
  }

  return { handle, verify };
}
