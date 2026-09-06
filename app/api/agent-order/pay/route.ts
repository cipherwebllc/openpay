// GET /api/agent-order/pay?h=&cart=&table=&pickupAt= — エージェント注文の **x402 リソース**。
//
// 402 → X-PAYMENT / PAYMENT-SIGNATURE → facilitator verify/settle という既存 x402 レール
// (app/api/paid/_shared.ts) を **踏襲** する。ただし amount / payTo / resource が注文ごとに動的なため
// _shared の first-party 固定価格 helper は使えないため、同形のフローをこの route に閉じて組む。
//   - amount   = computeAgentOrder が menu から確定した合計 (顧客申告額は信じない)
//   - payTo    = record.config.to (@handle 権威・project_mobileorder_receiver_config_to)
//   - resource = 正規順 (h, cart, table, pickupAt) で組んだ自 URL (MCP の accepts.resource 照合用)
//   - chain    = storefront.chain の deployment (facilitator/forwarder 未対応は 422 unsupported_chain)
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
import { isBeforeOpen, isPastLastOrder, pickupSlots } from '@/lib/shopTime';
import { createJpycPaymentRequirements } from '@/lib/x402/requirements';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { resolveFacilitatorPaymentStatus } from '@/lib/x402/facilitatorStatus';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { caip2ForChainId } from '@/lib/x402/network';
import { decodeAgentCart, computeAgentOrder } from '@/lib/agentOrder';
import { sanitizeTable } from '@/lib/orderRelay';
import {
  createAgentOrderSnapshot,
  parseAgentOrderSettlement,
  parseBoundAgentOrderSnapshot,
  pickupAtForAgentOrderSnapshot,
  type AgentOrderSettlement,
  type AgentOrderSnapshot,
} from '@/lib/x402/agentOrderRecovery';
import {
  claimPaymentRedelivery,
  isFacilitatorPreBroadcastRejection,
  lookupPaymentRedelivery,
  paymentRedeliveryIdentity,
  promotePaymentRedelivery,
  releasePaymentRedelivery,
  type PaymentRedeliveryBinding,
  type PaymentRedeliveryIdentity,
  type PaymentRedeliveryRecord,
} from '@/lib/x402/paymentRedelivery';
import { checkFacilitatorStatusRateLimit } from '@/lib/x402/facilitatorStatusRateLimit';
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
  transaction?: string | null;
  network?: string;
} & Record<string, unknown>;

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
  // Cloudflare 配下では接続元 (x-vercel-forwarded-for) と cf-connecting-ip の両方が要る (lib/net/ipHash.ts)。
  for (const name of ['x-forwarded-for', 'x-real-ip', 'x-vercel-forwarded-for', 'cf-connecting-ip']) {
    const value = req.headers.get(name);
    if (value) h.set(name, value);
  }
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

function paymentInvalidResponse(): NextResponse {
  return NextResponse.json(
    { x402Version: 1, error: 'payment_invalid' },
    { status: 402 },
  );
}

function pendingRecoveryResponse(snapshot: AgentOrderSnapshot): NextResponse {
  return NextResponse.json(
    {
      success: false,
      errorReason: 'pending',
      transaction: null,
      network: caip2ForChainId(snapshot.chainId),
      payer: snapshot.payer,
    },
    { status: 202 },
  );
}

async function settledOrderResponse(input: {
  req: Request;
  snapshot: AgentOrderSnapshot;
  settlement: AgentOrderSettlement;
}): Promise<NextResponse> {
  const { req, snapshot, settlement } = input;
  const txHash = settlement.transaction;
  const orderId = `agent-${txHash.slice(0, 18)}`;

  // 受注登録 (付帯処理) を既存の受注リレーへ委譲する。掟13 の隔離: **受注登録の失敗 (KV 障害 /
  // on-chain 検証遅延 / notify の想定外 throw) が「決済成功」という本体を巻き込まない** ための防御。
  // 支払いは既に settle 済 (不可逆) なので、notify がこけても 200 + orderRegistered:false + txHash を
  // 返し、店主は履歴/txHash から追える。ここで throw を握るのはこの波及を断つためであり、他意はない。
  let orderRegistered = false;
  try {
    const notifyReq = new Request(
      new URL(
        `/api/order/notify?h=${encodeURIComponent(snapshot.handle)}`,
        req.url,
      ),
      {
        method: 'POST',
        headers: cloneForwardHeaders(req),
        body: JSON.stringify({
          token: 'jpyc',
          txHash,
          chainId: snapshot.chainId,
          merchant: snapshot.merchant,
          orderId,
          items: snapshot.items,
          description: snapshot.table ?? undefined,
          pickupAt: snapshot.pickupAt ?? undefined,
          from: settlement.payer,
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
    amountJpyc: formatUnits(
      BigInt(snapshot.totalMinor),
      snapshot.decimals,
    ),
    orderRegistered,
  });
  res.headers.set('X-PAYMENT-RESPONSE', encodeJsonBase64(settlement));
  res.headers.set(
    'PAYMENT-RESPONSE',
    encodePaymentResponseHeaderValue(settlement),
  );
  return res;
}

async function recoverMatchedPayment(input: {
  req: Request;
  identity: PaymentRedeliveryIdentity;
  binding: PaymentRedeliveryBinding;
  record: PaymentRedeliveryRecord;
}): Promise<NextResponse> {
  const { req, identity, binding, record } = input;
  const snapshot = parseBoundAgentOrderSnapshot({
    context: record.context,
    facilitatorBody: record.facilitatorBody,
    resource: binding.resource,
    identity,
  });
  if (snapshot === null) return paymentInvalidResponse();

  if (record.state === 'settled') {
    const settlement = parseAgentOrderSettlement(
      record.settlement,
      snapshot,
    );
    return settlement === null
      ? paymentInvalidResponse()
      : settledOrderResponse({ req, snapshot, settlement });
  }

  if (!(await checkFacilitatorStatusRateLimit(req))) {
    return pendingRecoveryResponse(snapshot);
  }
  const status = await resolveFacilitatorPaymentStatus(
    record.facilitatorBody,
  );
  if (
    !status.ok ||
    status.state !== 'settled' ||
    status.txHash === null
  ) {
    return pendingRecoveryResponse(snapshot);
  }
  const settlement = parseAgentOrderSettlement(
    {
      success: true,
      transaction: status.txHash,
      network: caip2ForChainId(status.chainId),
      payer: status.payer,
    },
    snapshot,
  );
  if (settlement === null) return paymentInvalidResponse();

  const promotion = await promotePaymentRedelivery({
    identity,
    binding,
    settlement,
  });
  if (promotion.kind === 'conflict') return paymentInvalidResponse();
  return settledOrderResponse({ req, snapshot, settlement });
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
  const resourceUrl = canonicalResourceUrl(
    handle,
    cartParam,
    tableParam,
    pickupAtParam,
  );
  const binding: PaymentRedeliveryBinding = {
    scope: 'agent-order',
    resource: resourceUrl,
  };

  const paymentSignatureHeader = req.headers.get('PAYMENT-SIGNATURE');
  const paymentHeader = req.headers.get('x-payment');
  let decodedPaymentPayload: unknown;
  let decodedPaymentPayloadReady = false;
  if (paymentSignatureHeader) {
    try {
      decodedPaymentPayload = decodePaymentSignatureHeaderValue(
        paymentSignatureHeader,
      );
      decodedPaymentPayloadReady = true;
    } catch {
      // 既存 challenge 形を保つため、current requirements 生成後の payload error へ委ねる。
    }
  } else if (paymentHeader) {
    try {
      decodedPaymentPayload = decodePaymentHeader(paymentHeader);
      decodedPaymentPayloadReady = true;
    } catch {
      // 既存 challenge 形を保つため、current requirements 生成後の payload error へ委ねる。
    }
  }

  const paymentIdentity = decodedPaymentPayloadReady
    ? paymentRedeliveryIdentity(decodedPaymentPayload)
    : null;
  let paymentScopeConflict = false;
  if (paymentIdentity) {
    const delivery = await lookupPaymentRedelivery(
      paymentIdentity,
      binding,
    );
    if (delivery.kind === 'match') {
      // 支払い済み retry は current menu/live 状態を再評価せず、初回 verify 時の immutable
      // server snapshot だけを使う。決済後の売切/閉店/価格変更が受注消失へ波及するのを断つ。
      return recoverMatchedPayment({
        req,
        identity: paymentIdentity,
        binding,
        record: delivery.record,
      });
    }
    // missing/unavailable では cache を解錠せず、従来の current verify/settle へ進む。
    // 復旧 KV の障害が新規の正当な注文決済を停止する波及を断つ。
    paymentScopeConflict = delivery.kind === 'conflict';
  }

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

  // storefront.chain (JPYC slug) → network-aware chainId。facilitator 対象外、forwarder / JPYC
  // 未設定チェーンは分割 settle 不可 = 422 unsupported_chain (誤設定を silent に成立させない)。
  const chainId = chainForSlug(record.storefront.chain).id;
  const deployment = resolveDeployment('jpyc', chainId);
  if (
    !x402FacilitatorConfig.supportedChainIds.includes(chainId) ||
    !deployment ||
    configuredJpycForwarderFor(chainId) === null
  ) {
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
    isBeforeOpen(Date.now(), record.storefront.openFrom)
  ) {
    return NextResponse.json({ error: 'store_not_accepting' }, { status: 409 });
  }
  if (
    env.enablePreorderTime &&
    isPastLastOrder(Date.now(), record.storefront.lastOrder)
  ) {
    return NextResponse.json({ error: 'store_not_accepting' }, { status: 409 });
  }
  if (
    env.enablePreorderTime &&
    record.storefront.mode === 'preorder' &&
    pickupSlots(
      Date.now(),
      record.storefront.minLeadMinutes,
      record.storefront.lastOrder,
    ).length === 0
  ) {
    return NextResponse.json({ error: 'store_not_accepting' }, { status: 409 });
  }
  if (soldOut && cartItems.some((item) => soldOut.has(item.id))) {
    return NextResponse.json({ error: 'item_sold_out' }, { status: 409 });
  }

  const shopName =
    record.storefront.shopName || record.config.name?.trim() || `@${handle}`;
  const description = `${shopName} — ${order.summary}`.slice(0, 240);

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

  if (!paymentSignatureHeader && !paymentHeader) {
    return challenge(resourceUrl, description, accepts, 'payment_required');
  }
  if (paymentScopeConflict) {
    return challenge(resourceUrl, description, accepts, 'payment_invalid');
  }
  if (decodedPaymentPayloadReady && paymentIdentity === null) {
    return challenge(
      resourceUrl,
      description,
      accepts,
      'invalid_payment_payload',
    );
  }

  // payload (v2 PAYMENT-SIGNATURE / v1 X-PAYMENT) → facilitator v1 body に正規化 (_shared と同形)。
  let facilitatorBody: Record<string, unknown>;
  if (paymentSignatureHeader) {
    let payloadV2: unknown;
    try {
      payloadV2 = decodedPaymentPayloadReady
        ? decodedPaymentPayload
        : decodePaymentSignatureHeaderValue(paymentSignatureHeader);
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
    facilitatorBody = { ...v1Body };
  } else {
    let payload: unknown;
    try {
      payload = decodedPaymentPayloadReady
        ? decodedPaymentPayload
        : decodePaymentHeader(paymentHeader!);
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
  if (verifyRes.status !== 200 || verifyBody.isValid !== true) {
    // status recovery は verify 前に exact payment→resource record が一致した経路だけで行う。
    // 任意の expired/invalid payload を current cart の受注へ付け替える波及を断つ。
    if (verifyRes.status !== 200) {
      return NextResponse.json(verifyBody, { status: verifyRes.status });
    }
    return challenge(
      resourceUrl,
      description,
      accepts,
      verifyBody.invalidReason ?? 'payment_invalid',
    );
  }

  if (paymentIdentity === null) {
    return challenge(resourceUrl, description, accepts, 'payment_invalid');
  }
  let payer: Address;
  try {
    payer = getAddress(verifyBody.payer ?? '');
  } catch {
    return challenge(resourceUrl, description, accepts, 'payment_invalid');
  }

  const snapshot = createAgentOrderSnapshot({
    handle,
    merchant: configTo,
    payer,
    chainId,
    decimals: deployment.decimals,
    items: order.items,
    totalMinor: order.totalMinor,
    resource: resourceUrl,
    table: sanitizeTable(tableParam),
    pickupAt: pickupAtForAgentOrderSnapshot(pickupAtParam),
  });
  if (
    snapshot === null ||
    parseBoundAgentOrderSnapshot({
      context: snapshot,
      facilitatorBody,
      resource: resourceUrl,
      identity: paymentIdentity,
    }) === null
  ) {
    return challenge(resourceUrl, description, accepts, 'payment_invalid');
  }

  const claim = await claimPaymentRedelivery({
    identity: paymentIdentity,
    binding,
    facilitatorBody,
    context: snapshot,
  });
  if (claim.kind === 'conflict') {
    return challenge(resourceUrl, description, accepts, 'payment_invalid');
  }
  if (claim.kind === 'match') {
    return recoverMatchedPayment({
      req,
      identity: paymentIdentity,
      binding,
      record: claim.record,
    });
  }
  // unavailable は従来 settle を許す一方、record を確認できない request から status 回復は
  // 行わない。補助 KV 障害を決済停止へ波及させず、未束縛 status の注文解錠も増やさない。
  const recoveryClaimed = claim.kind === 'claimed';
  const recoveryOwnerToken =
    claim.kind === 'claimed' ? claim.record.ownerToken : null;

  const settleRes = await settlePayment(
    new Request(new URL('/api/facilitator/settle', req.url), {
      method: 'POST',
      headers: cloneForwardHeaders(req),
      body: bodyText,
    }),
  );
  const settleBody = (await settleRes.json()) as SettleBody;
  if (
    recoveryOwnerToken !== null &&
    isFacilitatorPreBroadcastRejection(settleRes.status, settleBody)
  ) {
    await releasePaymentRedelivery({
      identity: paymentIdentity,
      binding,
      ownerToken: recoveryOwnerToken,
    });
  }
  if (settleRes.status !== 200 || settleBody.success !== true) {
    if (
      recoveryClaimed &&
      settleBody.errorReason === 'pending' &&
      (await checkFacilitatorStatusRateLimit(req))
    ) {
      const status = await resolveFacilitatorPaymentStatus(
        facilitatorBody,
      );
      if (
        status.ok &&
        status.state === 'settled' &&
        status.txHash !== null
      ) {
        const recovered = parseAgentOrderSettlement(
          {
            success: true,
            transaction: status.txHash,
            network: caip2ForChainId(status.chainId),
            payer: status.payer,
          },
          snapshot,
        );
        if (recovered) {
          const promotion = await promotePaymentRedelivery({
            identity: paymentIdentity,
            binding,
            settlement: recovered,
          });
          if (promotion.kind === 'conflict') {
            return paymentInvalidResponse();
          }
          return settledOrderResponse({
            req,
            snapshot,
            settlement: recovered,
          });
        }
      }
    }
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

  const settlement = parseAgentOrderSettlement(
    {
      ...settleBody,
      success: true,
      network: settleBody.network ?? caip2ForChainId(snapshot.chainId),
      payer: settleBody.payer ?? snapshot.payer,
    },
    snapshot,
  );
  if (settlement === null) {
    // malformed な内部 success が空 txHash の受注登録へ波及するのを断つ。facilitator の
    // 正常 success 契約は transaction/network/payer を常に返すため、通常応答は不変。
    return NextResponse.json(
      { success: false, errorReason: 'settlement_invalid' },
      { status: 502 },
    );
  }
  if (recoveryClaimed) {
    const promotion = await promotePaymentRedelivery({
      identity: paymentIdentity,
      binding,
      settlement,
    });
    if (promotion.kind === 'conflict') return paymentInvalidResponse();
  }
  return settledOrderResponse({ req, snapshot, settlement });
}
