// 加盟店の外部サーバーに「コピペで動く」JPYC ゲートを発行する。
// 旧スニペットは '@/lib/x402/requirements' を import するリポ内前提の骨子例で、外部サーバーでは
// 動かなかった (加盟店の実組み込みで発覚)。本版は依存ゼロ (Node 18+ の fetch のみ) の自己完結で、
// accepts は加盟店自身のカタログ掲載 (/api/discovery) から取得する — 手数料・forwarder・
// commitVersion の改定に自動追従し、サーバー側にマジックナンバーを焼き込まない。

import { LEGAL_ENTITY } from '@/lib/legal';

const ORIGIN = new URL(LEGAL_ENTITY.siteUrl).origin;

export function buildPaywallSnippet(resourceUrl: string): string {
  return `// OpenPay JPYC x402 ゲート (自己完結・Node 18+/Next.js/Express どこでも)
// 使い方: 課金したいハンドラの先頭で await jpycGate(req) を呼び、
//   - 戻り値が Response ならそれをそのまま返す (未払い 402 / 検証失敗)
//   - null なら支払い済み — 本来の処理を続行し、レスポンスに receipt ヘッダを付ける
const OPENPAY = ${JSON.stringify(ORIGIN)};
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
}

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

/* ── Next.js App Router での使用例 ──────────────────────────
export async function GET(request) {
  const gate = await jpycGate(request);
  if (gate instanceof Response) return gate;
  const res = Response.json({ your: 'paid content' });
  res.headers.set('X-PAYMENT-RESPONSE', gate.paymentResponseHeader);
  return res;
}
── Express での使用例 ─────────────────────────────────────
app.get('/api/paid-thing', async (req, res) => {
  const gate = await jpycGate({ headers: { get: (k) => req.get(k) } });
  if (gate instanceof Response) {
    return res.status(gate.status).set('content-type', 'application/json').send(await gate.text());
  }
  res.set('X-PAYMENT-RESPONSE', gate.paymentResponseHeader);
  res.json({ your: 'paid content' });
});
──────────────────────────────────────────────────────── */`;
}
