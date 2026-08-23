// dual-rail 出品の USDC verify 中継 (CDP facilitator)。実装: lib/x402/dualRailRelay.ts。
import { NextResponse } from 'next/server';
import { handleDualRailRelay } from '@/lib/x402/dualRailRelay';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(req: Request): Promise<NextResponse> {
  return handleDualRailRelay(req, 'verify');
}
