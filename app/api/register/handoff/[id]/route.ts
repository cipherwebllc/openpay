import type { NextResponse } from 'next/server';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { STORE_HANDOFF_TOKEN_HEADER } from '@/lib/storeDevicePayment';
import { readHandoff } from '@/lib/storeHandoff';
import { handoffDeps } from '@/lib/storeHandoffDeps';
import { handoffDisabled, handoffFailure, handoffJson } from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 10;

// 受け渡しの状態。トークン (ヘッダ) なし = お客様向けの公開項目だけ、あり = お店の端末向けに署名まで。
// 偽の id・トークンは lib が KV に触れる前に弾く。トークン付き (= 照合済みの端末) の読み取りは間隔をあけて
// 繰り返すので KV の rate limit を付けない。トークンなし (お客様) は IP ごとに 60 回/分まで。
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  const { id } = await params;
  const token = req.headers.get(STORE_HANDOFF_TOKEN_HEADER);
  if (
    token === null &&
    !(await checkIpRateLimit('store-handoff-read', hashIpBucket(clientIp(req)), 60, 60))
  ) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const r = await readHandoff(id, token, handoffDeps());
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
