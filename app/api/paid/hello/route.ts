// AI agent 向け demo paid endpoint。x402 protocol で課金される最小例として
// 「message + timestamp」を返すだけ。withX402Payment を 1 行で wrap する DX を
// 示す reference 実装。
//
// 動作確認:
//   curl -i http://localhost:3000/api/paid/hello
//     → 402 Payment Required + accepts: [paymentRequirements]
//   X402_TEST_MODE=true npm run dev で起動 → 200 + JSON body

import { NextResponse, type NextRequest } from 'next/server';
import { withX402Payment } from '@/lib/x402/middleware';

export const runtime = 'nodejs';
// new Date() を返すため static 化を避ける
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
