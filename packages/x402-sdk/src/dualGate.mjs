// dual-rail 出品者ゲート: createJpycGate (JPYC・Polygon) に USDC (Base・標準 x402) の面を重ねる。
//
// USDC 面は OpenPay のリレー (/api/x402/relay/*) から取得・中継する:
//   - requirements: 402 に並記する完成形 (v1Accepts + PAYMENT-REQUIRED ヘッダ) を配布
//   - verify/settle: CDP facilitator への中継 (支払いは購入者 → 出品者 payTo へ直接)
//
// 隔離 (最重要): USDC 面の取得失敗 (リレー未点灯・障害) は null に落とし、JPYC ゲートだけで
// 継続する — 付帯面 (USDC) の障害が決済本体 (JPYC) を止めない。
//
// レール振り分け: PAYMENT-SIGNATURE ヘッダ (v2 = USDC クライアント)、または x-payment (v1) の
// network が USDC 面と一致するときだけ USDC レール。その他は従来の JPYC ゲートへ委譲する。
// JPYC レールの 402 には USDC accepts を追記 (decorate) して両面を常に見せる。

import { createJpycGate } from './gate.mjs';

const DEFAULT_OPENPAY_ORIGIN = 'https://open-pay.jp';
const USDC_FACE_CACHE_MS = 5 * 60_000;

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
  openpayOrigin = DEFAULT_OPENPAY_ORIGIN,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxUpstreamSeconds,
  settlementGraceSeconds,
}) {
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    throw new Error('resourceId is required (shown as MY_RESOURCE_ID in your OpenPay listing)');
  }
  const jpyc = createJpycGate({
    resourceUrl,
    openpayOrigin,
    fetchImpl,
    now,
    ...(maxUpstreamSeconds === undefined ? {} : { maxUpstreamSeconds }),
    ...(settlementGraceSeconds === undefined ? {} : { settlementGraceSeconds }),
  });
  const origin = openpayOrigin.replace(/\/+$/, '');

  let usdcCache = null;
  let usdcCachedAt = 0;
  async function usdcFace() {
    if (usdcCache !== null && now() - usdcCachedAt < USDC_FACE_CACHE_MS) {
      return usdcCache;
    }
    try {
      const response = await fetchImpl(
        `${origin}/api/x402/relay/requirements?resourceId=${encodeURIComponent(resourceId)}`,
      );
      if (!response.ok) return null;
      const face = await response.json();
      if (!face || typeof face !== 'object' || !face.v1Accepts) return null;
      usdcCache = face;
      usdcCachedAt = now();
      return face;
    } catch {
      // リレー未点灯/障害 → USDC 面なしで継続 (JPYC 本体を止めない)。キャッシュしない
      // (復旧したら次のリクエストで拾う)。
      return null;
    }
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

  // USDC レールの 402。JPYC accepts の取得失敗は握って USDC 面だけで返す
  // (challenge の失敗で支払いエラーの伝達自体を落とさない)。
  async function usdcChallenge(usdc, error) {
    let jpycAccepts = [];
    try {
      const headerless = { url: resourceUrl, headers: { get: () => null } };
      const challenge = await jpyc.verify(headerless);
      if (challenge instanceof Response && challenge.status === 402) {
        const body = await challenge.json();
        if (Array.isArray(body.accepts)) jpycAccepts = body.accepts;
      }
    } catch {
      /* JPYC カタログ未掲載などは USDC のみで継続 */
    }
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
      const relay = async (path) => {
        const response = await fetchImpl(`${origin}/api/x402/relay/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceId,
            ...(signatureHeader
              ? { paymentSignatureHeader: signatureHeader }
              : { paymentHeader: v1Header }),
          }),
        });
        return response.json();
      };
      const verification = await relay('verify');
      if (verification.isValid !== true) {
        return usdcChallenge(usdc, verification.invalidReason || 'payment_invalid');
      }
      return {
        async settle() {
          const settlement = await relay('settle');
          if (settlement.success !== true) {
            return usdcChallenge(usdc, settlement.errorReason || 'settlement_failed');
          }
          return { paymentResponseHeader: encodeBase64Json(settlement) };
        },
      };
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
