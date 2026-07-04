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
};

type PaidContent = (ctx: { payer?: string }) => Promise<NextResponse> | NextResponse;
type PreparedPayment = {
  body: unknown;
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

function paymentBody(resource: FirstPartyResource, paymentPayload: unknown) {
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

export async function handleFirstPartyPaidGet(
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

  let prepared: PreparedPayment;
  if (paymentSignatureHeader) {
    let paymentPayloadV2: unknown;
    try {
      paymentPayloadV2 = decodePaymentSignatureHeaderValue(paymentSignatureHeader);
    } catch {
      return paymentChallenge(resource, 'invalid_payment_payload');
    }
    try {
      prepared = paymentBody(resource, paymentPayloadV2);
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
    const v1Body = v2PayloadToV1Body(paymentPayloadV2, prepared.accepts);
    if (!v1Body) {
      return paymentChallenge(resource, 'invalid_payment_payload');
    }
    prepared = { ...prepared, body: v1Body };
  } else {
    let paymentPayload: unknown;
    try {
      paymentPayload = decodePaymentHeader(paymentHeader!);
    } catch {
      return paymentChallenge(resource, 'invalid_payment_payload');
    }

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

  const res = await content({ payer: settleBody.payer ?? verifyBody.payer });
  res.headers.set('X-PAYMENT-RESPONSE', encodeJsonBase64(settleBody));
  res.headers.set('PAYMENT-RESPONSE', encodePaymentResponseHeaderValue(settleBody));
  return res;
}
