// x402 課金がかかる demo endpoint。動作確認は curl http://localhost:3000/api/paid/hello
// で 402 (default) / `X402_TEST_MODE=true npm run dev` で 200。

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
