// 加盟店の外部サーバーに「コピペで動く」JPYC ゲートを発行する。
// 旧スニペットは '@/lib/x402/requirements' を import するリポ内前提の骨子例で、外部サーバーでは
// 動かなかった (加盟店の実組み込みで発覚)。本版は依存ゼロ (Node 18+ の fetch のみ) の自己完結で、
// accepts は加盟店自身のカタログ掲載 (/api/discovery/[id]) から取得する — 手数料・forwarder・
// commitVersion の改定に自動追従し、サーバー側にマジックナンバーを焼き込まない。
//
// dual-rail (dualRail 指定時): USDC/Base 面を /api/x402/relay/requirements から取得して
// 402 に並記し、USDC 支払いは /api/x402/relay/{verify,settle} へ中継するゲートを発行する。
// USDC 面の取得失敗 (リレー未点灯/障害) は null に落として JPYC のみで継続する —
// 付帯面 (USDC) の障害が決済本体 (JPYC) を止めない隔離。

import { LEGAL_ENTITY } from '@/lib/legal';

const ORIGIN = new URL(LEGAL_ENTITY.siteUrl).origin;

type SnippetOptions = {
  resourceId: string;
  expectedRecipient: string;
  dualRail?: boolean;
  expectedUsdcRecipient?: string;
};

// JPYC accepts の取得 + 402 応答 + facilitator 呼び出し (両版共通)。gateName で組み込み例の
// 関数名だけ差し替える。
function jpycCoreSegment(resourceUrl: string, opts: SnippetOptions): string {
  return `const OPENPAY = ${JSON.stringify(ORIGIN)};
const MY_RESOURCE_URL = ${JSON.stringify(resourceUrl)}; // 登録した URL
const MY_RESOURCE_ID = ${JSON.stringify(opts.resourceId)}; // 自分の出品 ID
const EXPECTED_RECIPIENT = ${JSON.stringify(opts.expectedRecipient)}; // 自分で設定した JPYC 受取先。discovery 応答から設定しない
const address = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
if (!MY_RESOURCE_ID || !MY_RESOURCE_ID.trim()) throw new Error('resourceId is required from your own OpenPay listing');
if (!address(EXPECTED_RECIPIENT)) throw new Error('expectedRecipient is required and must be a seller wallet address');
class SellerPinError extends Error {
  constructor(reason) {
    super('OpenPay seller gate: ' + reason);
    this.name = 'SellerPinError';
  }
}
function rejectRequirements(reason) {
  // 登録値の不一致が誤送金へ波及しないよう、402 配布・キャッシュ・決済を停止する
  console.error('[openpay-x402] ' + reason);
  throw new SellerPinError(reason);
}

let acceptsCache = null;
let acceptsCachedAt = 0;
async function myAccepts() {
  if (acceptsCache && Date.now() - acceptsCachedAt < 5 * 60_000) return acceptsCache;
  const res = await fetch(OPENPAY + '/api/discovery/' + encodeURIComponent(MY_RESOURCE_ID));
  if (res.status === 404) throw new Error('resource not found in OpenPay catalog: ' + MY_RESOURCE_ID);
  if (!res.ok) throw new Error('OpenPay catalog request failed (HTTP ' + res.status + '): ' + MY_RESOURCE_ID);
  const mine = await res.json();
  if (mine?.id !== MY_RESOURCE_ID || mine.resource !== MY_RESOURCE_URL) rejectRequirements('resource identity mismatch');
  if (!Array.isArray(mine.accepts)) rejectRequirements('resource has no payment requirements');
  if (mine.accepts.length === 0) throw new Error('resource has no payment requirements');
  for (const accept of mine.accepts) {
    const split = accept?.extra?.openpay;
    if (address(split?.merchant) !== address(EXPECTED_RECIPIENT)) rejectRequirements('JPYC recipient mismatch');
    if (split.mode !== 'forwarder-split' || !address(split.forwarder) || address(accept.payTo) !== address(split.forwarder)) {
      rejectRequirements('JPYC forwarder mismatch');
    }
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

function buildJpycOnlySnippet(resourceUrl: string, opts: SnippetOptions): string {
  return `// OpenPay JPYC x402 ゲート (自己完結・Node 18+/Next.js/Express どこでも)
// npm: openpay-x402-sdk の createJpycGate でも同等のゲートを import できます。
// 使い方: 課金したいハンドラの先頭で await jpycGate(req) を呼び、
//   - 戻り値が Response ならそれをそのまま返す (未払い 402 / 検証失敗)
//   - { paymentResponseHeader } なら支払い済み — 本来の処理を続行し、レスポンスに receipt ヘッダを付ける
${jpycCoreSegment(resourceUrl, opts)}

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

function buildDualRailSnippet(resourceUrl: string, opts: SnippetOptions): string {
  return `// OpenPay dual-rail x402 ゲート (JPYC + USDC/Base・自己完結・Node 18+/Next.js/Express どこでも)
// JPYC は OpenPay facilitator、USDC (Base) は OpenPay の CDP リレー経由で精算します。
// 使い方: 課金したいハンドラの先頭で await x402Gate(req) を呼び、
//   - 戻り値が Response ならそれをそのまま返す (未払い 402 / 検証失敗)
//   - それ以外なら支払い済み — 本来の処理を続行し、レスポンスに receipt ヘッダを付ける
${jpycCoreSegment(resourceUrl, opts)}
const EXPECTED_USDC_RECIPIENT = ${JSON.stringify(opts.expectedUsdcRecipient ?? '')}; // 自分で設定した USDC 受取先 (JPYC と別のアドレスも可)
if (!address(EXPECTED_USDC_RECIPIENT)) throw new Error('expectedUsdcRecipient is required and must be a seller wallet address');
function validateUsdc(face) {
  if (face?.resourceId !== MY_RESOURCE_ID) rejectRequirements('USDC resource identity mismatch');
  let required;
  try {
    required = JSON.parse(Buffer.from(face.paymentRequiredHeader, 'base64').toString('utf8'));
  } catch {
    rejectRequirements('invalid USDC payment requirements header');
  }
  if (!Array.isArray(required?.accepts) || required.accepts.length === 0) rejectRequirements('USDC header has no payment requirements');
  const accepts = [face.v1Accepts, face.v2Accept, ...required.accepts];
  for (const accept of accepts) {
    if (address(accept?.payTo) !== address(EXPECTED_USDC_RECIPIENT)) rejectRequirements('USDC recipient mismatch');
  }
  const v1 = face.v1Accepts;
  const network = { base: 'eip155:8453', 'base-sepolia': 'eip155:84532' }[v1.network];
  for (const accept of accepts.slice(1)) {
    if (!network || accept.network !== network || accept.scheme !== v1.scheme ||
        !address(v1.asset) || address(accept.asset) !== address(v1.asset) || accept.amount !== v1.maxAmountRequired) {
      rejectRequirements('USDC requirements mismatch');
    }
  }
}

let usdcCache = null;
let usdcCachedAt = 0;
async function usdcFace() {
  // USDC 面 (Base)。取得失敗 (未点灯/障害) は null → JPYC のみで 402 を返して継続する
  // (USDC 面の障害が JPYC 決済本体を止めない)。
  if (usdcCache && Date.now() - usdcCachedAt < 5 * 60_000) return usdcCache;
  let face;
  try {
    const res = await fetch(
      OPENPAY + '/api/x402/relay/requirements?resourceId=' + encodeURIComponent(MY_RESOURCE_ID),
    );
    if (!res.ok) return null;
    face = await res.json();
  } catch {
    return null;
  }
  // 宛先不一致を障害時の JPYC 継続処理に流さず、両レールを停止する
  validateUsdc(face);
  usdcCache = face;
  usdcCachedAt = Date.now();
  return face;
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
  const usdc = await usdcFace();
  let jpycAccepts = [];
  let jpycError;
  try {
    jpycAccepts = await myAccepts();
  } catch (error) {
    // JPYC の取得障害が USDC を止めないよう隔離する。信頼違反は両レールを停止する
    if (error instanceof SellerPinError || !usdc) throw error;
    jpycError = error;
  }
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
    const relay = async (path) => {
      const response = await fetch(OPENPAY + '/api/x402/relay/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: MY_RESOURCE_ID,
          paymentRequirements: usdc.v1Accepts,
          ...(sigHeader ? { paymentSignatureHeader: sigHeader } : { paymentHeader: header }),
        }),
      });
      if (response.status === 409) {
        // 古い価格で停止し続けないよう再取得・pin 検証する。元の支払いは自動再送しない
        usdcCache = null;
        const fresh = await usdcFace();
        if (!fresh) throw new Error('OpenPay USDC requirements unavailable');
        return json402([...jpycAccepts, fresh.v1Accepts], 'requirements_mismatch', fresh.paymentRequiredHeader);
      }
      return response.json();
    };
    const verify = await relay('verify');
    if (verify instanceof Response) return verify;
    if (verify.isValid !== true) return challenge(verify.invalidReason || 'payment_invalid');
    const settle = await relay('settle');
    if (settle instanceof Response) return settle;
    if (settle.success !== true) return challenge(settle.errorReason || 'settlement_failed');
    return {
      paymentResponseHeader: Buffer.from(JSON.stringify(settle)).toString('base64'),
    };
  }

  // ── JPYC レール (従来どおり OpenPay facilitator へ) ──
  if (jpycError) throw jpycError;
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
  opts: SnippetOptions,
): string {
  return opts.dualRail
    ? buildDualRailSnippet(resourceUrl, opts)
    : buildJpycOnlySnippet(resourceUrl, opts);
}
