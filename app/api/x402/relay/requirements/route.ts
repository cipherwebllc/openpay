// dual-rail 出品の USDC 要件配布 (公開情報のみ)。実装: lib/x402/dualRailRelay.ts。
import { NextResponse } from 'next/server';
import { handleDualRailRequirements } from '@/lib/x402/dualRailRelay';

export const runtime = 'nodejs';
export const maxDuration = 15;

export async function GET(req: Request): Promise<NextResponse> {
  return handleDualRailRequirements(req);
}
