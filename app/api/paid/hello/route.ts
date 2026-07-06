// x402 課金がかかる demo endpoint。動作確認は curl http://localhost:3000/api/paid/hello
// で 402 (default) / `X402_TEST_MODE=true npm run dev` で 200。
//
// ⚠️ P2-O 注記: この route は **vanilla x402-next 互換デモ** (lib/x402/middleware の withX402Payment
// = 外部 facilitator・単一 transferWithAuthorization・手数料分割なし) で、sibling の demo/stores とは
// **別の money-path**。demo/stores は自前 facilitator (handleFirstPartyPaidGet・enableX402Facilitator
// でゲート・forwarder-split 1% 手数料) を通るが、hello はそれらを一切通らない (X402_NETWORK /
// X402_PAY_TO_ADDRESS / X402_TEST_MODE でのみ制御)。fee.ts / facilitatorConfig.ts を変えても hello に
// は効かない。「/api/paid/* は全部 OpenPay facilitator の 1% を通る」という前提で扱わないこと。

import { NextResponse, type NextRequest } from 'next/server';
import { withX402Payment } from '@/lib/x402/middleware';

export const runtime = 'nodejs';
// timestamp を含むため static prerender を無効化
export const dynamic = 'force-dynamic';

async function helloHandler(_request: NextRequest): Promise<NextResponse> {
  return NextResponse.json({
    message: 'Hello, paid AI agent.',
    timestamp: new Date().toISOString(),
  });
}

export const GET = withX402Payment(helloHandler, {
  description: 'OpenPay demo paid endpoint: returns hello + timestamp.',
});
