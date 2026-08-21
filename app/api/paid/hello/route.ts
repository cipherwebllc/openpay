// x402 課金がかかる demo endpoint。動作確認は curl http://localhost:3000/api/paid/hello
// で 402 (default) / `X402_TEST_MODE=true npm run dev` で 200。
//
// ⚠️ P2-O 注記: この route は **vanilla x402 デモ** (lib/x402/vanillaGate = 外部 facilitator・
// 単一 transferWithAuthorization・手数料分割なし) で、sibling の demo/stores とは
// **別の money-path**。demo/stores は自前 facilitator (handleFirstPartyPaidGet・
// enableX402Facilitator でゲート・forwarder-split 1% 手数料) を通るが、hello はそれらを
// 一切通らない (X402_NETWORK / X402_PAY_TO_ADDRESS / X402_TEST_MODE でのみ制御)。
// fee.ts / facilitatorConfig.ts を変えても hello には効かない。
// 「/api/paid/* は全部 OpenPay facilitator の 1% を通る」という前提で扱わないこと。
//
// 2026-07-28: x402-next (v1 のみ・x402scan が「migrate to v2 spec」で登録拒否) から
// vanillaGate (v2 dual-stack) へ移行。v1 X-PAYMENT クライアントは引き続き支払える
// (gate は両形式を受理)。価格は従来どおり X402_PRICE (env・Money 形式) が権威。

import { NextResponse, type NextRequest } from 'next/server';
import { x402Config } from '@/lib/x402/config';
import { OPENPAY_CANONICAL_ORIGIN } from '@/lib/x402/firstParty';
import { handleVanillaPaidGet } from '@/lib/x402/vanillaGate';

export const runtime = 'nodejs';
// timestamp を含むため static prerender を無効化
export const dynamic = 'force-dynamic';

async function helloContent(): Promise<NextResponse> {
  return NextResponse.json({
    message: 'Hello, paid AI agent.',
    timestamp: new Date().toISOString(),
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // polygon 系 (JPYC facilitator の領分) に配線された場合、defaultPrice は Money 文字列で
  // なくなる。vanillaGate の network 検査でも弾かれるが、価格の型からも先に閉じておく。
  const price = x402Config.defaultPrice;
  if (typeof price !== 'string') {
    return NextResponse.json(
      { x402Version: 1, error: 'payment_facility_unavailable' },
      { status: 503 },
    );
  }
  return handleVanillaPaidGet(
    request,
    {
      resourceUrl: `${OPENPAY_CANONICAL_ORIGIN}/api/paid/hello`,
      // 掲載面 (CDP Bazaar / agentic.market) のカード文言 = この description (2026-08-20 実測)。
      description:
        'End-to-end smoke test for x402 clients: returns a greeting plus the settlement timestamp, so an agent can prove its payment path works before spending on real data.',
      price,
      outputSchema: {
        input: { type: 'http', method: 'GET', discoverable: true },
      },
      bazaar: {
        output: {
          example: {
            message: 'Hello, paid AI agent.',
            timestamp: '2026-08-20T23:02:04.176Z',
          },
        },
      },
    },
    helloContent,
  );
}
