// dual-rail 出品者ゲート: createJpycGate (JPYC・Polygon) に USDC (Base・標準 x402) の面を重ねる。
//
// USDC 面は OpenPay のリレー (/api/x402/relay/*) から取得・中継する:
//   - requirements: 402 に並記する完成形 (v1Accepts + PAYMENT-REQUIRED ヘッダ) を配布
//   - verify/settle: CDP facilitator への中継 (支払いは購入者 → 出品者 payTo へ直接)
//
// 隔離 (最重要): USDC 面の取得失敗 (リレー未点灯・障害) は null に落とし、JPYC ゲートだけで
// 継続する — 付帯面 (USDC) の障害が決済本体 (JPYC) を止めない。宛先不一致は両面を停止する。
//
// レール振り分け: PAYMENT-SIGNATURE ヘッダ (v2 = USDC クライアント)、または x-payment (v1) の
// network が USDC 面と一致するときだけ USDC レール。その他は従来の JPYC ゲートへ委譲する。
// JPYC レールの 402 には USDC accepts を追記 (decorate) して両面を常に見せる。

import { createJpycGate } from './gate.mjs';
import { createAuthorizationClaims, usdcAuthorizationClaim } from './authorizationClaims.mjs';
import { assertSellerPins, SellerPinError, validateUsdcFace } from './sellerPins.mjs';

const DEFAULT_OPENPAY_ORIGIN = 'https://open-pay.jp';
const USDC_FACE_CACHE_MS = 5 * 60_000;
// USDC authorizations are not resource-bound: share claims so another endpoint's gate
// cannot start duplicate upstream work with the same chain/asset/payer/nonce.
const usdcAuthorizationClaims = new Map();

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

export function createDualGate({
  resourceUrl,
  resourceId,
  expectedRecipient,
  expectedUsdcRecipient,
  openpayOrigin = DEFAULT_OPENPAY_ORIGIN,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxUpstreamSeconds,
  settlementGraceSeconds,
} = {}) {
  assertSellerPins(resourceId, expectedRecipient);
  assertSellerPins(resourceId, expectedUsdcRecipient, 'expectedUsdcRecipient');
  const jpyc = createJpycGate({
    resourceUrl,
    resourceId,
    expectedRecipient,
    openpayOrigin,
    fetchImpl,
    now,
    ...(maxUpstreamSeconds === undefined ? {} : { maxUpstreamSeconds }),
    ...(settlementGraceSeconds === undefined ? {} : { settlementGraceSeconds }),
  });
  const origin = openpayOrigin.replace(/\/+$/, '');
  const { claimAuthorization, releaseAuthorization, hasValidityWindow } = createAuthorizationClaims({
    now, maxUpstreamSeconds, settlementGraceSeconds,
  }, usdcAuthorizationClaims);

  let usdcCache = null;
  let usdcCachedAt = 0;
  async function usdcFace() {
    if (usdcCache !== null && now() - usdcCachedAt < USDC_FACE_CACHE_MS) {
      return usdcCache;
    }
    let face;
    try {
      const response = await fetchImpl(
        `${origin}/api/x402/relay/requirements?resourceId=${encodeURIComponent(resourceId)}`,
      );
      if (!response.ok) return null;
      face = await response.json();
    } catch {
      // リレー未点灯/障害 → USDC 面なしで継続 (JPYC 本体を止めない)。キャッシュしない
      // (復旧したら次のリクエストで拾う)。
      return null;
    }
    // Keep trust failures outside the availability fallback: poisoning must stop both rails.
    validateUsdcFace(face, resourceId, expectedUsdcRecipient, decodeBase64Json);
    usdcCache = face;
    usdcCachedAt = now();
    return face;
  }

  // JPYC ゲートが返した 402 に USDC 面 (accepts + PAYMENT-REQUIRED ヘッダ) を追記する。
  // 402 以外・USDC 面なし・body が読めない場合はそのまま返す (壊さない)。
  async function decorate402(response, usdc) {
    if (!usdc || !(response instanceof Response) || response.status !== 402) {
      return response;
    }
    let body;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (!body || !Array.isArray(body.accepts)) return response;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json');
    if (typeof usdc.paymentRequiredHeader === 'string') {
      headers.set('PAYMENT-REQUIRED', usdc.paymentRequiredHeader);
    }
    return new Response(
      JSON.stringify({ ...body, accepts: [...body.accepts, usdc.v1Accepts] }),
      { status: 402, headers },
    );
  }

  // Reuse this payment's validated JPYC/USDC snapshot even if another request refreshes the cache.
  async function usdcChallenge(usdc, jpycAccepts, error) {
    const headers = { 'content-type': 'application/json' };
    if (typeof usdc.paymentRequiredHeader === 'string') {
      headers['PAYMENT-REQUIRED'] = usdc.paymentRequiredHeader;
    }
    return new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [...jpycAccepts, usdc.v1Accepts],
        error,
      }),
      { status: 402, headers },
    );
  }

  async function availableJpycAccepts(request) {
    try {
      const challenge = await jpyc.verify({ url: request.url, headers: { get: () => null } });
      return (await challenge.json()).accepts;
    } catch (error) {
      // A JPYC outage must not block USDC; trust failures must still stop both rails.
      if (error instanceof SellerPinError) throw error;
      return [];
    }
  }

  async function verify(request) {
    const usdc = await usdcFace();
    const signatureHeader = request.headers.get('payment-signature');
    const v1Header = request.headers.get('x-payment');
    let v1Network = null;
    if (v1Header) {
      try {
        const decoded = decodeBase64Json(v1Header);
        if (decoded && typeof decoded === 'object') v1Network = decoded.network;
      } catch {
        /* 不正 header は下のレール判定で JPYC 側に流し、そこで 402 になる */
      }
    }

    const usdcRail =
      usdc !== null &&
      (Boolean(signatureHeader) ||
        (typeof v1Network === 'string' && v1Network === usdc.v1Accepts.network));

    if (usdcRail) {
      const jpycAccepts = await availableJpycAccepts(request);
      let paymentPayload;
      try {
        paymentPayload = decodeBase64Json(signatureHeader || v1Header);
      } catch {
        // A malformed preferred header must not bypass the claim via the other rail/header.
        return usdcChallenge(usdc, jpycAccepts, 'invalid_payment_payload');
      }
      const authorization = usdcAuthorizationClaim(paymentPayload, usdc.v2Accept);
      // Without a usable identity/expiry, verification cannot safely grant upstream work.
      if (authorization === null) return usdcChallenge(usdc, jpycAccepts, 'invalid_payment_payload');
      const claimed = claimAuthorization(authorization);
      if (!claimed.ok) return usdcChallenge(usdc, jpycAccepts, claimed.reason);

      const relay = async (path) => {
        const response = await fetchImpl(`${origin}/api/x402/relay/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId,
            paymentRequirements: usdc.v1Accepts,
            ...(signatureHeader
              ? { paymentSignatureHeader: signatureHeader }
              : { paymentHeader: v1Header }),
          }),
        });
        if (response.status === 409) {
          // A stale price must not wedge payments for the cache TTL. Re-pin fresh terms,
          // then ask the buyer again without replaying the old authorization.
          usdcCache = null;
          const fresh = await usdcFace();
          if (!fresh) throw new Error('OpenPay USDC requirements unavailable');
          return usdcChallenge(fresh, jpycAccepts, 'requirements_mismatch');
        }
        return response.json();
      };
      let verification;
      try {
        verification = await relay('verify');
      } catch (error) {
        // Verify cannot settle or grant upstream work on failure; release only this tentative owner.
        releaseAuthorization(claimed.claim);
        throw error;
      }
      if (verification instanceof Response) {
        releaseAuthorization(claimed.claim);
        return verification;
      }
      if (verification.isValid !== true) {
        releaseAuthorization(claimed.claim);
        return usdcChallenge(usdc, jpycAccepts, verification.invalidReason || 'payment_invalid');
      }
      // A slow verify must not consume the margin promised to the seller's upstream work.
      if (!hasValidityWindow(authorization)) {
        return usdcChallenge(usdc, jpycAccepts, 'insufficient_validity_window');
      }
      // As in JPYC, keep the claim until validBefore once upstream can run. Settlement
      // errors (including ambiguous transport/JSON/503 and 409) must not repeat that work;
      // even a definitive settle rejection cannot undo an already executed upstream call.
      return {
        async settle() {
          const settlement = await relay('settle');
          if (settlement instanceof Response) return settlement;
          if (settlement.success !== true) {
            return usdcChallenge(usdc, jpycAccepts, settlement.errorReason || 'settlement_failed');
          }
          return { paymentResponseHeader: encodeBase64Json(settlement) };
        },
      };
    }

    if (usdc && !signatureHeader && !v1Header) {
      return usdcChallenge(usdc, await availableJpycAccepts(request), 'payment_required');
    }

    const result = await jpyc.verify(request);
    if (result instanceof Response) return decorate402(result, usdc);
    return {
      async settle() {
        const settlement = await result.settle();
        return settlement instanceof Response
          ? decorate402(settlement, usdc)
          : settlement;
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
