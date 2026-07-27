import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { createJpycPaymentRequirements } from '@/lib/x402/requirements';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import {
  firstPartyAmount,
  firstPartyPayTo,
  firstPartyResourceUrl,
  type FirstPartyResource,
} from '@/lib/x402/firstParty';
import { POST as verifyPayment } from '@/app/api/facilitator/verify/route';
import { POST as settlePayment } from '@/app/api/facilitator/settle/route';
import { resolveFacilitatorPaymentStatus } from '@/lib/x402/facilitatorStatus';
import {
  claimPaymentRedelivery,
  isFacilitatorPreBroadcastRejection,
  lookupPaymentRedelivery,
  paymentRedeliveryIdentity,
  promotePaymentRedelivery,
  releasePaymentRedelivery,
  type PaymentRedeliveryBinding,
  type PaymentSettlement,
} from '@/lib/x402/paymentRedelivery';
import { checkFacilitatorStatusRateLimit } from '@/lib/x402/facilitatorStatusRateLimit';
import { caip2ForChainId, chainIdFromCaip2 } from '@/lib/x402/network';
import {
  buildPaymentRequiredV2,
  decodePaymentSignatureHeaderValue,
  encodePaymentRequiredHeaderValue,
  encodePaymentResponseHeaderValue,
  toV2Accept,
  v2PayloadToV1Body,
} from '@/lib/x402/v2';

type VerifyBody = {
  isValid?: boolean;
  invalidReason?: string;
  payer?: string;
};

type SettleBody = {
  success?: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string | null;
  network?: string;
} & Record<string, unknown>;

type PaidContent = (ctx: { payer?: string }) => Promise<NextResponse> | NextResponse;
type PreparedPayment = {
  body: Record<string, unknown>;
  accepts: ReturnType<typeof createJpycPaymentRequirements>;
};

function encodeJsonBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodePaymentHeader(raw: string): unknown {
  const json = Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json) as unknown;
}

function cloneForwardHeaders(req: Request): Headers {
  const h = new Headers({ 'content-type': 'application/json' });
  const forwardedFor = req.headers.get('x-forwarded-for');
  const realIp = req.headers.get('x-real-ip');
  if (forwardedFor) h.set('x-forwarded-for', forwardedFor);
  if (realIp) h.set('x-real-ip', realIp);
  return h;
}

function paymentBody(
  resource: FirstPartyResource,
  paymentPayload: unknown,
): PreparedPayment {
  const accepts = createJpycPaymentRequirements({
    amount: firstPartyAmount(resource),
    payTo: firstPartyPayTo(),
    resource: firstPartyResourceUrl(resource),
    description: resource.description,
    chainId: x402FacilitatorConfig.chainId,
    mimeType: 'application/json',
  });
  return {
    body: {
      x402Version: 1,
      paymentPayload,
      paymentRequirements: accepts[0],
    },
    accepts,
  };
}

async function paidContentResponse(
  content: PaidContent,
  settlement: PaymentSettlement,
  payer?: string,
): Promise<NextResponse> {
  const res = await content({ payer });
  res.headers.set('X-PAYMENT-RESPONSE', encodeJsonBase64(settlement));
  res.headers.set(
    'PAYMENT-RESPONSE',
    encodePaymentResponseHeaderValue(settlement),
  );
  return res;
}

function pendingRecoveryResponse(input: {
  chainId: number;
  payer: string;
}): NextResponse {
  return NextResponse.json(
    {
      success: false,
      errorReason: 'pending',
      transaction: null,
      network: caip2ForChainId(input.chainId),
      payer: input.payer,
    },
    { status: 202 },
  );
}

function pendingRecoveryDetails(
  facilitatorBody: Record<string, unknown>,
): { chainId: number; payer: string } | null {
  const paymentPayload = facilitatorBody.paymentPayload;
  if (
    typeof paymentPayload !== 'object' ||
    paymentPayload === null ||
    Array.isArray(paymentPayload)
  ) {
    return null;
  }
  const network = (paymentPayload as Record<string, unknown>).network;
  const payload = (paymentPayload as Record<string, unknown>).payload;
  if (
    typeof network !== 'string' ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const authorization = (payload as Record<string, unknown>).authorization;
  if (
    typeof authorization !== 'object' ||
    authorization === null ||
    Array.isArray(authorization)
  ) {
    return null;
  }
  const payer = (authorization as Record<string, unknown>).from;
  const chainId = chainIdFromCaip2(network);
  if (
    chainId === null ||
    typeof payer !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(payer)
  ) {
    return null;
  }
  return { chainId, payer };
}

function setPaymentRequiredV2Header(
  res: NextResponse,
  resource: FirstPartyResource,
  accepts: ReturnType<typeof createJpycPaymentRequirements>,
  error: string,
): NextResponse {
  const paymentRequired = buildPaymentRequiredV2({
    url: firstPartyResourceUrl(resource),
    description: resource.description,
    mimeType: 'application/json',
    accepts: accepts.map(toV2Accept),
    bazaarInfo: resource.outputSchema,
    error,
  });
  res.headers.set('PAYMENT-REQUIRED', encodePaymentRequiredHeaderValue(paymentRequired));
  return res;
}

function paymentChallenge(
  resource: FirstPartyResource,
  error: string,
  status = 402,
): NextResponse {
  try {
    const accepts = createJpycPaymentRequirements({
      amount: firstPartyAmount(resource),
      payTo: firstPartyPayTo(),
      resource: firstPartyResourceUrl(resource),
      description: resource.description,
      chainId: x402FacilitatorConfig.chainId,
      mimeType: 'application/json',
    });
    // outputSchema は x402scan の payable-index 用の発見メタ。チャレンジ応答のみに添付し、
    // verify/settle に渡す requirements (paymentBody) には含めない (facilitator parse を汚さない)。
    const discoverable = accepts.map((accept) => ({
      ...accept,
      outputSchema: resource.outputSchema,
    }));
    return setPaymentRequiredV2Header(
      NextResponse.json(
        { x402Version: 1, accepts: discoverable, error },
        { status },
      ),
      resource,
      accepts,
      error,
    );
  } catch (e) {
    // Misconfigured requirements must not leak a malformed 402 challenge to buyers.
    return NextResponse.json(
      {
        x402Version: 1,
        error: 'payment_facility_unavailable',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }
}

/**
 * x402 の有料エンドポイントは共有キャッシュに載せない。
 *
 * 402 チャレンジは支払い条件 (payTo / 金額 / forwarder / commitVersion) を、200 は購入者だけが
 * 受け取るべき有料コンテンツを含む。Next.js 既定の `public, max-age=0, must-revalidate` は
 * **共有キャッシュ (CDN / プロキシ) への保存を許可**してしまう (本番実測 2026-07-27)。
 *
 * 何の波及を断つ防御か (掟13): ①条件変更後も古い支払い条件が配布され、買い手が旧 payTo /
 * 旧価格で払う ②URL だけを鍵にしたキャッシュが、未払いリクエストへ有料コンテンツを返す。
 * `Vary` に X-PAYMENT が無い以上、no-store で塞ぐのが確実。
 */
function noStore(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * ハンドラの出口で一律 no-store を被せる。分岐が 20 以上あり、個々の return に付けると
 * 新しい分岐を足したときに漏れるため、境界 1 箇所で保証する。
 */
export async function handleFirstPartyPaidGet(
  req: Request,
  resource: FirstPartyResource,
  content: PaidContent,
): Promise<NextResponse> {
  return noStore(await handleFirstPartyPaidGetInner(req, resource, content));
}

async function handleFirstPartyPaidGetInner(
  req: Request,
  resource: FirstPartyResource,
  content: PaidContent,
): Promise<NextResponse> {
  if (!env.enableX402Facilitator) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const paymentSignatureHeader = req.headers.get('PAYMENT-SIGNATURE');
  const paymentHeader = req.headers.get('x-payment');
  if (!paymentSignatureHeader && !paymentHeader) {
    return paymentChallenge(resource, 'payment_required');
  }

  let paymentPayload: unknown;
  const usesV2Header = paymentSignatureHeader !== null;
  if (paymentSignatureHeader) {
    try {
      paymentPayload = decodePaymentSignatureHeaderValue(paymentSignatureHeader);
    } catch {
      return paymentChallenge(resource, 'invalid_payment_payload');
    }
  } else {
    try {
      paymentPayload = decodePaymentHeader(paymentHeader!);
    } catch {
      return paymentChallenge(resource, 'invalid_payment_payload');
    }
  }
  const redeliveryIdentity = paymentRedeliveryIdentity(paymentPayload);
  if (!redeliveryIdentity) {
    return paymentChallenge(resource, 'invalid_payment_payload');
  }

  // 検索 API の query が違う別コンテンツまで同じ支払いで解錠される波及を断つため、
  // payment identity の原子的 claim を resource path + 実リクエスト query へ束縛する。
  const requestUrl = new URL(req.url);
  const redeliveryBinding: PaymentRedeliveryBinding = {
    scope: 'first-party',
    resource: `${firstPartyResourceUrl(resource)}${requestUrl.search}`,
  };
  const deliveryLookup = await lookupPaymentRedelivery(
    redeliveryIdentity,
    redeliveryBinding,
  );
  if (deliveryLookup.kind === 'conflict') {
    return paymentChallenge(resource, 'payment_invalid');
  }
  const delivery =
    deliveryLookup.kind === 'match' ? deliveryLookup.record : null;
  if (delivery?.state === 'settled') {
    // settled cache は facilitator success または下の on-chain 完全照合からのみ昇格する。
    // 同一 payment の応答喪失を再課金せず配信へ戻し、通常の verify/settle は一切再実行しない。
    return paidContentResponse(
      content,
      delivery.settlement,
      delivery.settlement.payer,
    );
  }
  if (delivery?.state === 'pending') {
    if (!(await checkFacilitatorStatusRateLimit(req))) {
      return NextResponse.json(
        { ok: false, error: 'ip_rate_limited' },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }
    let status: Awaited<ReturnType<typeof resolveFacilitatorPaymentStatus>>;
    try {
      status = await resolveFacilitatorPaymentStatus(
        delivery.facilitatorBody,
      );
    } catch {
      const pendingDetails = pendingRecoveryDetails(
        delivery.facilitatorBody,
      );
      if (!pendingDetails) {
        return paymentChallenge(resource, 'payment_invalid');
      }
      // read-only status の想定外障害を pending payment の再 settle へ波及させず、
      // 二重 broadcast を避けるため同じ 202 回復待ちへ閉じる。
      return pendingRecoveryResponse(pendingDetails);
    }
    if (
      status.ok &&
      status.state === 'settled' &&
      status.txHash !== null
    ) {
      const recoveredSettlement: PaymentSettlement = {
        success: true,
        transaction: status.txHash,
        network: caip2ForChainId(status.chainId),
        payer: status.payer,
      };
      const promotion = await promotePaymentRedelivery({
        identity: redeliveryIdentity,
        binding: redeliveryBinding,
        settlement: recoveredSettlement,
      });
      if (promotion.kind === 'conflict') {
        return paymentChallenge(resource, 'payment_invalid');
      }
      const settlement =
        promotion.kind === 'promoted' ||
        promotion.kind === 'already-settled'
          ? promotion.record.settlement
          : recoveredSettlement;
      return paidContentResponse(
        content,
        settlement,
        settlement.payer,
      );
    }
    // pending marker が存在する payment を unused/error 時に settle へ戻すと、同時 request や
    // status の一時的不整合が二重 broadcast / relayer gas 消費へ波及するため、settled の完全照合
    // 以外はすべて既存 pending 語彙で待たせる。
    const pendingDetails = status.ok
      ? status
      : pendingRecoveryDetails(delivery.facilitatorBody);
    if (!pendingDetails) {
      return paymentChallenge(resource, 'payment_invalid');
    }
    return pendingRecoveryResponse(pendingDetails);
  }

  let prepared: PreparedPayment;
  try {
    prepared = paymentBody(resource, paymentPayload);
  } catch (e) {
    // Misconfigured requirements must not pass an unverifiable body into verify/settle.
    return NextResponse.json(
      {
        x402Version: 1,
        error: 'payment_facility_unavailable',
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }
  if (usesV2Header) {
    const v1Body = v2PayloadToV1Body(paymentPayload, prepared.accepts);
    if (!v1Body) {
      return paymentChallenge(resource, 'invalid_payment_payload');
    }
    prepared = { ...prepared, body: { ...v1Body } };
  }

  const bodyText = JSON.stringify(prepared.body);
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
    const error = verifyBody.invalidReason ?? 'payment_invalid';
    return setPaymentRequiredV2Header(
      NextResponse.json(
        {
          x402Version: 1,
          accepts: prepared.accepts,
          error,
        },
        { status: 402 },
      ),
      resource,
      prepared.accepts,
      error,
    );
  }

  // verify 後・settle 前の原子的 claim により、同じ payment identity を競合 resource が同時に
  // settle して共有 gas と別コンテンツ配信へ波及するのを断つ。KV 障害時だけ既存経路へ fail-open。
  const claim = await claimPaymentRedelivery({
    identity: redeliveryIdentity,
    binding: redeliveryBinding,
    facilitatorBody: prepared.body,
  });
  if (claim.kind === 'conflict') {
    return paymentChallenge(resource, 'payment_invalid');
  }
  if (claim.kind === 'match' && claim.record.state === 'settled') {
    return paidContentResponse(
      content,
      claim.record.settlement,
      claim.record.settlement.payer,
    );
  }
  if (claim.kind === 'match') {
    const pendingDetails = pendingRecoveryDetails(
      claim.record.facilitatorBody,
    );
    if (!pendingDetails) {
      return paymentChallenge(resource, 'payment_invalid');
    }
    // lookup miss 同士の race で先行 request が claim 済みなら、後続を再 settle へ進めず
    // 先行 broadcast の完了待ちに閉じ、二重 broadcast と gas 消費への波及を断つ。
    return pendingRecoveryResponse(pendingDetails);
  }
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
      identity: redeliveryIdentity,
      binding: redeliveryBinding,
      ownerToken: recoveryOwnerToken,
    });
  }
  if (settleRes.status !== 200 || settleBody.success !== true) {
    if (settleRes.status === 200) {
      const error = settleBody.errorReason ?? 'settlement_failed';
      return setPaymentRequiredV2Header(
        NextResponse.json(
          {
            x402Version: 1,
            accepts: prepared.accepts,
            error,
          },
          { status: 402 },
        ),
        resource,
        prepared.accepts,
        error,
      );
    }
    return NextResponse.json(settleBody, { status: settleRes.status });
  }

  const successfulSettlement = settleBody as PaymentSettlement;
  const promotion = await promotePaymentRedelivery({
    identity: redeliveryIdentity,
    binding: redeliveryBinding,
    settlement: successfulSettlement,
  });
  if (promotion.kind === 'conflict') {
    return paymentChallenge(resource, 'payment_invalid');
  }
  const deliveredSettlement =
    promotion.kind === 'promoted' ||
    promotion.kind === 'already-settled'
      ? promotion.record.settlement
      : successfulSettlement;
  return paidContentResponse(
    content,
    deliveredSettlement,
    deliveredSettlement.payer ?? verifyBody.payer,
  );
}
