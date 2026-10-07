import type { NextResponse } from 'next/server';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { createHandoffSession } from '@/lib/storeHandoff';
import { handoffDeps } from '@/lib/storeHandoffDeps';
import {
  handoffDisabled,
  handoffFailure,
  handoffJson,
  readHandoffBody,
} from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 15;

// お店の端末が会計ごとに受け渡しセッションを作る (plans/store-gas-wallet.md P2)。
export async function POST(req: Request): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  if (!(await checkIpRateLimit('store-handoff-create', hashIpBucket(clientIp(req)), 10, 60))) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const parsed = await readHandoffBody(req);
  if (!parsed.ok) return parsed.res;
  const r = await createHandoffSession(parsed.body, handoffDeps());
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
