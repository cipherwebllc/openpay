import type { NextResponse } from 'next/server';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { submitHandoffAuth } from '@/lib/storeHandoff';
import { handoffDeps } from '@/lib/storeHandoffDeps';
import {
  handoffDisabled,
  handoffFailure,
  handoffJson,
  readHandoffBody,
} from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 15;

// お客様のスマホが署名を渡す。検証してから 1 セッション 1 枠で預かる (lib/storeHandoff.ts)。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  if (!(await checkIpRateLimit('store-handoff-auth', hashIpBucket(clientIp(req)), 20, 60))) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const parsed = await readHandoffBody(req);
  if (!parsed.ok) return parsed.res;
  const { id } = await params;
  const r = await submitHandoffAuth(id, parsed.body, handoffDeps());
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
