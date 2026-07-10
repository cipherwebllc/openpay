// GET /api/agent-order/pay?h=&cart=&table=&pickupAt= — エージェント注文の **x402 リソース**。
//
// 402 → X-PAYMENT / PAYMENT-SIGNATURE → facilitator verify/settle という既存 x402 レール
// (app/api/paid/_shared.ts) を **踏襲** する。ただし amount / payTo / resource が注文ごとに動的なため
// _shared の first-party helper は使えず、同形のフローをここに閉じて組む (_shared.ts は無改変・掟12)。
//   - amount   = computeAgentOrder が menu から確定した合計 (顧客申告額は信じない)
//   - payTo    = record.config.to (@handle 権威・project_mobileorder_receiver_config_to)
//   - resource = 正規順 (h, cart, table, pickupAt) で組んだ自 URL (MCP の accepts.resource 照合用)
//   - chain    = storefront.chain の deployment (forwarder 未設定チェーンは 422 unsupported_chain)
// settle 成功後、既存の受注リレー (/api/order/notify) の POST handler を import して内部呼び出しし、
// サーバー検証済みの注文を店主の受注画面へ届ける。notify 失敗は **決済成功を巻き込まない** (掟13)。
//
// flag: enableX402Facilitator && enableOrderRelay && enableAgentOrder が全 true でなければ 404。

import { NextResponse } from 'next/server';
import { getAddress, formatUnits, type Address } from 'viem';
import { env } from '@/lib/env';
import { normalizeHandle, isValidHandleFormat } from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import { chainForSlug } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';
import { readShopLive } from '@/lib/shopLiveStore';
import { isPastLastOrder } from '@/lib/shopTime';
import { createJpycPaymentRequirements } from '@/lib/x402/requirements';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { decodeAgentCart, computeAgentOrder } from '@/lib/agentOrder';
import {
  buildPaymentRequiredV2,
  decodePaymentSignatureHeaderValue,
  encodePaymentRequiredHeaderValue,
  encodePaymentResponseHeaderValue,
  toV2Accept,
  v2PayloadToV1Body,
} from '@/lib/x402/v2';
import { POST as verifyPayment } from '@/app/api/facilitator/verify/route';
import { POST as settlePayment } from '@/app/api/facilitator/settle/route';
import { POST as notifyOrder } from '@/app/api/order/notify/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Accepts = ReturnType<typeof createJpycPaymentRequirements>;

type VerifyBody = { isValid?: boolean; invalidReason?: string; payer?: string };
type SettleBody = {
  success?: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
};

function agentOrderEnabled(): boolean {
  return (
    env.enableX402Facilitator && env.enableOrderRelay && env.enableAgentOrder
  );
}

function encodeJsonBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodePaymentHeader(raw: string): unknown {
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown;
}

// verify/settle へ渡す転送ヘッダ (レート制限の IP 判定用に元 IP を引き継ぐ・_shared と同形)。
function cloneForwardHeaders(req: Request): Headers {
  const h = new Headers({ 'content-type': 'application/json' });
  const forwardedFor = req.headers.get('x-forwarded-for');
  const realIp = req.headers.get('x-real-ip');
  if (forwardedFor) h.set('x-forwarded-for', forwardedFor);
  if (realIp) h.set('x-real-ip', realIp);
  return h;
}

// 正規順 (h, cart, table, pickupAt) の resource URL を組む。**受信した生 cart 文字列をそのまま echo**
// する (MCP も URLSearchParams で同順・同エンコードに組むため byte 一致し、MCP の resource 照合を通す)。
function canonicalResourceUrl(
  handle: string,
  cartParam: string,
  table: string | null,
  pickupAt: string | null,
): string {
  const params = new URLSearchParams();
  params.set('h', handle);
  params.set('cart', cartParam);
  if (table !== null) params.set('table', table);
  if (pickupAt !== null) params.set('pickupAt', pickupAt);
  return `${OPENPAY_CANONICAL_ORIGIN}/api/agent-order/pay?${params.toString()}`;
}

function paymentRequired(
  res: NextResponse,
  resourceUrl: string,
  description: string,
  accepts: Accepts,
  error: string,
): NextResponse {
  const paymentRequiredV2 = buildPaymentRequiredV2({
    url: resourceUrl,
    description,
    mimeType: 'application/json',
    accepts: accepts.map(toV2Accept),
    error,
  });
  res.headers.set(
    'PAYMENT-REQUIRED',
    encodePaymentRequiredHeaderValue(paymentRequiredV2),
  );
  return res;
}

function challenge(
  resourceUrl: string,
  description: string,
  accepts: Accepts,
  error: string,
  status = 402,
): NextResponse {
  return paymentRequired(
    NextResponse.json({ x402Version: 1, accepts, error }, { status }),
    resourceUrl,
    description,
    accepts,
    error,
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!agentOrderEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const handle = normalizeHandle(url.searchParams.get('h') ?? '');
  if (!handle || !isValidHandleFormat(handle)) {
    return NextResponse.json({ error: 'invalid_handle' }, { status: 422 });
  }
  const cartParam = url.searchParams.get('cart') ?? '';
  const tableParam = url.searchParams.get('table'); // 生値 (resource echo 用・notify が sanitize)
  const pickupAtParam = url.searchParams.get('pickupAt');

  const cartItems = decodeAgentCart(cartParam);
  if (cartItems === null) {
    return NextResponse.json({ error: 'invalid_cart' }, { status: 422 });
  }

  const resolved = await resolveHandle(handle);
  if (!resolved.ok) {
    return NextResponse.json({ error: 'kv_unavailable' }, { status: 503 });
  }
  const record = resolved.record;
  if (!record || !record.storefront) {
    return NextResponse.json({ error: 'no_storefront' }, { status: 404 });
  }
  let configTo: Address;
  try {
    configTo = getAddress(record.config.to);
  } catch {
    return NextResponse.json({ error: 'no_storefront' }, { status: 404 });
  }

  // storefront.chain (JPYC slug) → network-aware chainId。forwarder / JPYC 未設定チェーンは
  // 分割 settle 不可 = 422 unsupported_chain (誤設定を silent に成立させない)。
  const chainId = chainForSlug(record.storefront.chain).id;
  const deployment = resolveDeployment('jpyc', chainId);
  if (!deployment || configuredJpycForwarderFor(chainId) === null) {
    return NextResponse.json({ error: 'unsupported_chain' }, { status: 422 });
  }

  const order = computeAgentOrder(
    record.storefront,
    cartItems,
    deployment.decimals,
  );
  if (!order.ok) {
    return NextResponse.json({ error: order.reason }, { status: 422 });
  }

  // 不可逆な支払い challenge を作る前に、人間経路と同じ店舗受付状態を検証する。
  // 静的停止は live flag 非依存。live 読取の KV 障害は readShopLive が EMPTY へ fail-open し、
  // 付帯状態ストアの障害が決済本体へ波及するのを防ぐ (掟13)。
  if (record.storefront.acceptingOrders === false) {
    return NextResponse.json({ error: 'store_not_accepting' }, { status: 409 });
  }
  let soldOut: Set<string> | null = null;
  if (env.enableShopLive) {
    const live = await readShopLive(handle);
    if (live.paused) {
      return NextResponse.json({ error: 'store_not_accepting' }, { status: 409 });
    }
    soldOut = new Set(live.soldOut);
  }
  if (
    env.enablePreorderTime &&
    isPastLastOrder(Date.now(), record.storefront.lastOrder)
  ) {
    return NextResponse.json({ error: 'store_not_accepting' }, { status: 409 });
  }
  if (soldOut && cartItems.some((item) => soldOut.has(item.id))) {
    return NextResponse.json({ error: 'item_sold_out' }, { status: 409 });
  }

  const shopName =
    record.storefront.shopName || record.config.name?.trim() || `@${handle}`;
  const description = `${shopName} — ${order.summary}`.slice(0, 240);
  const resourceUrl = canonicalResourceUrl(
    handle,
    cartParam,
    tableParam,
    pickupAtParam,
  );

  let accepts: Accepts;
  try {
    accepts = createJpycPaymentRequirements({
      amount: order.totalMinor,
      payTo: configTo,
      resource: resourceUrl,
      description,
      chainId,
      mimeType: 'application/json',
    });
  } catch (e) {
    // 誤設定 (feeReceiver=burn 等) の壊れた requirements をエージェントへ渡さない (503 に倒す)。
    return NextResponse.json(
      {
        x402Version: 1,
        error: 'payment_facility_unavailable',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }

  const paymentSignatureHeader = req.headers.get('PAYMENT-SIGNATURE');
  const paymentHeader = req.headers.get('x-payment');
  if (!paymentSignatureHeader && !paymentHeader) {
    return challenge(resourceUrl, description, accepts, 'payment_required');
  }

  // payload (v2 PAYMENT-SIGNATURE / v1 X-PAYMENT) → facilitator v1 body に正規化 (_shared と同形)。
  let facilitatorBody: unknown;
  if (paymentSignatureHeader) {
    let payloadV2: unknown;
    try {
      payloadV2 = decodePaymentSignatureHeaderValue(paymentSignatureHeader);
    } catch {
      return challenge(
        resourceUrl,
        description,
        accepts,
        'invalid_payment_payload',
      );
    }
    const v1Body = v2PayloadToV1Body(payloadV2, accepts);
    if (!v1Body) {
      return challenge(
        resourceUrl,
        description,
        accepts,
        'invalid_payment_payload',
      );
    }
    facilitatorBody = v1Body;
  } else {
    let payload: unknown;
    try {
      payload = decodePaymentHeader(paymentHeader!);
    } catch {
      return challenge(
        resourceUrl,
        description,
        accepts,
        'invalid_payment_payload',
      );
    }
    facilitatorBody = {
      x402Version: 1,
      paymentPayload: payload,
      paymentRequirements: accepts[0],
    };
  }

  const bodyText = JSON.stringify(facilitatorBody);
  const verifyRes = await verifyPayment(
    new Request(new URL('/api/facilitator/verify', req.url), {
      method: 'POST',
      headers: cloneForwardHeaders(req),
      body: bodyText,
    }),
  );
  const verifyBody = (await verifyRes.json()) as VerifyBody;
  if (verifyRes.status !== 200) {
    return NextResponse.json(verifyBody, { status: verifyRes.status });
  }
  if (verifyBody.isValid !== true) {
    return challenge(
      resourceUrl,
      description,
      accepts,
      verifyBody.invalidReason ?? 'payment_invalid',
    );
  }

  const settleRes = await settlePayment(
    new Request(new URL('/api/facilitator/settle', req.url), {
      method: 'POST',
      headers: cloneForwardHeaders(req),
      body: bodyText,
    }),
  );
  const settleBody = (await settleRes.json()) as SettleBody;
  if (settleRes.status !== 200 || settleBody.success !== true) {
    if (settleRes.status === 200) {
      return challenge(
        resourceUrl,
        description,
        accepts,
        settleBody.errorReason ?? 'settlement_failed',
      );
    }
    return NextResponse.json(settleBody, { status: settleRes.status });
  }

  const txHash = settleBody.transaction ?? '';
  const payer = settleBody.payer ?? verifyBody.payer;
  const orderId = `agent-${txHash.slice(0, 18)}`;

  // 受注登録 (付帯処理) を既存の受注リレーへ委譲する。掟13 の隔離: **受注登録の失敗 (KV 障害 /
  // on-chain 検証遅延 / notify の想定外 throw) が「決済成功」という本体を巻き込まない** ための防御。
  // 支払いは既に settle 済 (不可逆) なので、notify がこけても 200 + orderRegistered:false + txHash を
  // 返し、店主は履歴/txHash から追える。ここで throw を握るのはこの波及を断つためであり、他意はない。
  let orderRegistered = false;
  try {
    const notifyReq = new Request(
      new URL(`/api/order/notify?h=${encodeURIComponent(handle)}`, req.url),
      {
        method: 'POST',
        headers: cloneForwardHeaders(req),
        body: JSON.stringify({
          token: 'jpyc',
          txHash,
          chainId,
          merchant: configTo,
          orderId,
          items: order.items, // サーバー検証済み StoredOrderItem[]
          description: tableParam ?? undefined, // テーブル番号ラベル (notify が sanitize)
          pickupAt:
            pickupAtParam !== null && /^\d+$/.test(pickupAtParam)
              ? Number(pickupAtParam)
              : undefined,
          from: payer,
        }),
      },
    );
    const notifyRes = await notifyOrder(notifyReq);
    const notifyBody = (await notifyRes.json()) as { ok?: boolean };
    orderRegistered = notifyRes.status === 200 && notifyBody.ok === true;
  } catch {
    orderRegistered = false;
  }

  const res = NextResponse.json({
    ok: true,
    orderId,
    txHash,
    amountJpyc: formatUnits(order.totalMinor, deployment.decimals),
    orderRegistered,
  });
  res.headers.set('X-PAYMENT-RESPONSE', encodeJsonBase64(settleBody));
  res.headers.set('PAYMENT-RESPONSE', encodePaymentResponseHeaderValue(settleBody));
  return res;
}
