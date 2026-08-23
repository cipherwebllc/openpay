// 加盟店の外部サーバーに「コピペで動く」JPYC ゲートを発行する。
// 旧スニペットは '@/lib/x402/requirements' を import するリポ内前提の骨子例で、外部サーバーでは
// 動かなかった (加盟店の実組み込みで発覚)。本版は依存ゼロ (Node 18+ の fetch のみ) の自己完結で、
// accepts は加盟店自身のカタログ掲載 (/api/discovery) から取得する — 手数料・forwarder・
// commitVersion の改定に自動追従し、サーバー側にマジックナンバーを焼き込まない。
//
// dual-rail (usdcResourceId 指定時): USDC/Base 面を /api/x402/relay/requirements から取得して
// 402 に並記し、USDC 支払いは /api/x402/relay/{verify,settle} へ中継するゲートを発行する。
// USDC 面の取得失敗 (リレー未点灯/障害) は null に落として JPYC のみで継続する —
// 付帯面 (USDC) の障害が決済本体 (JPYC) を止めない隔離。

import { LEGAL_ENTITY } from '@/lib/legal';

const ORIGIN = new URL(LEGAL_ENTITY.siteUrl).origin;

// JPYC accepts の取得 + 402 応答 + facilitator 呼び出し (両版共通)。gateName で組み込み例の
// 関数名だけ差し替える。
function jpycCoreSegment(resourceUrl: string): string {
  return `const OPENPAY = ${JSON.stringify(ORIGIN)};
const MY_RESOURCE_URL = ${JSON.stringify(resourceUrl)}; // /discovery に登録した URL と完全一致させること

let acceptsCache = null;
let acceptsCachedAt = 0;
async function myAccepts() {
  if (acceptsCache && Date.now() - acceptsCachedAt < 5 * 60_000) return acceptsCache;
  const res = await fetch(OPENPAY + '/api/discovery');
  const { items } = await res.json();
  const mine = (items || []).find((i) => i.resource === MY_RESOURCE_URL);
  if (!mine || !mine.accepts || mine.accepts.length === 0) {
    throw new Error('resource not found in OpenPay catalog: ' + MY_RESOURCE_URL);
  }
  acceptsCache = mine.accepts; // 手数料/forwarder の改定に自動追従 (5 分キャッシュ)
  acceptsCachedAt = Date.now();
  return acceptsCache;
}`;
}

function usageExamplesSegment(gateName: string): string {
  return `/* ── Next.js App Router での使用例 ──────────────────────────
export async function GET(request) {
  const gate = await ${gateName}(request);
  if (gate instanceof Response) return gate;
  const res = Response.json({ your: 'paid content' });
  res.headers.set('X-PAYMENT-RESPONSE', gate.paymentResponseHeader);
  return res;
}
── Express での使用例 ─────────────────────────────────────
app.get('/api/paid-thing', async (req, res) => {
  const gate = await ${gateName}({ headers: { get: (k) => req.get(k) } });
  if (gate instanceof Response) {
    return res.status(gate.status).set('content-type', 'application/json').send(await gate.text());
  }
  res.set('X-PAYMENT-RESPONSE', gate.paymentResponseHeader);
  res.json({ your: 'paid content' });
});
──────────────────────────────────────────────────────── */`;
}

function buildJpycOnlySnippet(resourceUrl: string): string {
  return `// OpenPay JPYC x402 ゲート (自己完結・Node 18+/Next.js/Express どこでも)
// npm: openpay-x402-sdk の createJpycGate でも同等のゲートを import できます。
// 使い方: 課金したいハンドラの先頭で await jpycGate(req) を呼び、
//   - 戻り値が Response ならそれをそのまま返す (未払い 402 / 検証失敗)
//   - null なら支払い済み — 本来の処理を続行し、レスポンスに receipt ヘッダを付ける
${jpycCoreSegment(resourceUrl)}

const json402 = (accepts, error) =>
  new Response(JSON.stringify({ x402Version: 1, accepts, error }), {
    status: 402,
    headers: { 'content-type': 'application/json' },
  });

// 戻り値: Response (それを返す) | { paymentResponseHeader } (支払い済み — 解錠して良い)
export async function jpycGate(request) {
  const accepts = await myAccepts();
  const header = request.headers.get('x-payment');
  if (!header) return json402(accepts, 'payment_required');

  let paymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return json402(accepts, 'invalid_payment_payload');
  }

  const body = JSON.stringify({
    x402Version: 1,
    paymentPayload,
    paymentRequirements: accepts[0],
  });
  const call = (path) =>
    fetch(OPENPAY + '/api/facilitator/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).then((r) => r.json());

  const verify = await call('verify');
  if (verify.isValid !== true) return json402(accepts, verify.invalidReason || 'payment_invalid');
  const settle = await call('settle');
  if (settle.success !== true) return json402(accepts, settle.errorReason || 'settlement_failed');

  return {
    // 解錠 OK。応答にこのヘッダを付けると買い手が受領証明を受け取れる:
    //   'X-PAYMENT-RESPONSE': paymentResponseHeader
    paymentResponseHeader: Buffer.from(JSON.stringify(settle)).toString('base64'),
  };
}

${usageExamplesSegment('jpycGate')}`;
}

function buildDualRailSnippet(resourceUrl: string, usdcResourceId: string): string {
  return `// OpenPay dual-rail x402 ゲート (JPYC + USDC/Base・自己完結・Node 18+/Next.js/Express どこでも)
// JPYC は OpenPay facilitator、USDC (Base) は OpenPay の CDP リレー経由で精算します。
// 使い方: 課金したいハンドラの先頭で await x402Gate(req) を呼び、
//   - 戻り値が Response ならそれをそのまま返す (未払い 402 / 検証失敗)
//   - それ以外なら支払い済み — 本来の処理を続行し、レスポンスに receipt ヘッダを付ける
${jpycCoreSegment(resourceUrl)}
const MY_RESOURCE_ID = ${JSON.stringify(usdcResourceId)}; // OpenPay 出品 ID (USDC 面のリレー先)

let usdcCache = null;
let usdcCachedAt = 0;
async function usdcFace() {
  // USDC 面 (Base)。取得失敗 (未点灯/障害) は null → JPYC のみで 402 を返して継続する
  // (USDC 面の障害が JPYC 決済本体を止めない)。
  if (usdcCache && Date.now() - usdcCachedAt < 5 * 60_000) return usdcCache;
  try {
    const res = await fetch(
      OPENPAY + '/api/x402/relay/requirements?resourceId=' + MY_RESOURCE_ID,
    );
    if (!res.ok) return null;
    const face = await res.json();
    if (!face || !face.v1Accepts) return null;
    usdcCache = face;
    usdcCachedAt = Date.now();
    return face;
  } catch {
    return null;
  }
}

const json402 = (accepts, error, paymentRequiredHeader) =>
  new Response(JSON.stringify({ x402Version: 1, accepts, error }), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      // v2 クライアント (CDP 等) は PAYMENT-REQUIRED ヘッダから USDC 要件を読む
      ...(paymentRequiredHeader ? { 'PAYMENT-REQUIRED': paymentRequiredHeader } : {}),
    },
  });

// 戻り値: Response (それを返す) | { paymentResponseHeader } (支払い済み — 解錠して良い)
export async function x402Gate(request) {
  const jpycAccepts = await myAccepts();
  const usdc = await usdcFace();
  const allAccepts = usdc ? [...jpycAccepts, usdc.v1Accepts] : jpycAccepts;
  const challenge = (error) =>
    json402(allAccepts, error, usdc ? usdc.paymentRequiredHeader : undefined);

  const sigHeader = request.headers.get('payment-signature'); // v2 (USDC クライアント)
  const header = request.headers.get('x-payment');
  if (!sigHeader && !header) return challenge('payment_required');

  let paymentPayload = null;
  if (header) {
    try {
      paymentPayload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
      return challenge('invalid_payment_payload');
    }
  }

  // ── USDC (Base) レール: v2 ヘッダ、または v1 ヘッダの network が USDC 面と一致 ──
  if (usdc && (sigHeader || (paymentPayload && paymentPayload.network === usdc.v1Accepts.network))) {
    const relay = (path) =>
      fetch(OPENPAY + '/api/x402/relay/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: MY_RESOURCE_ID,
          ...(sigHeader ? { paymentSignatureHeader: sigHeader } : { paymentHeader: header }),
        }),
      }).then((r) => r.json());
    const verify = await relay('verify');
    if (verify.isValid !== true) return challenge(verify.invalidReason || 'payment_invalid');
    const settle = await relay('settle');
    if (settle.success !== true) return challenge(settle.errorReason || 'settlement_failed');
    return {
      paymentResponseHeader: Buffer.from(JSON.stringify(settle)).toString('base64'),
    };
  }

  // ── JPYC レール (従来どおり OpenPay facilitator へ) ──
  const body = JSON.stringify({
    x402Version: 1,
    paymentPayload,
    paymentRequirements: jpycAccepts[0],
  });
  const call = (path) =>
    fetch(OPENPAY + '/api/facilitator/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).then((r) => r.json());

  const verify = await call('verify');
  if (verify.isValid !== true) return challenge(verify.invalidReason || 'payment_invalid');
  const settle = await call('settle');
  if (settle.success !== true) return challenge(settle.errorReason || 'settlement_failed');

  return {
    // 解錠 OK。応答にこのヘッダを付けると買い手が受領証明を受け取れる:
    //   'X-PAYMENT-RESPONSE': paymentResponseHeader
    paymentResponseHeader: Buffer.from(JSON.stringify(settle)).toString('base64'),
  };
}

${usageExamplesSegment('x402Gate')}`;
}

export function buildPaywallSnippet(
  resourceUrl: string,
  opts: { usdcResourceId?: string } = {},
): string {
  return opts.usdcResourceId
    ? buildDualRailSnippet(resourceUrl, opts.usdcResourceId)
    : buildJpycOnlySnippet(resourceUrl);
}
