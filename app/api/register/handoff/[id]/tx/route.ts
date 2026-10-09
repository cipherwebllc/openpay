import type { NextResponse } from 'next/server';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { STORE_HANDOFF_TOKEN_HEADER } from '@/lib/storeDevicePayment';
import { deviceAccessFailure, recordHandoffTx } from '@/lib/storeHandoff';
import { handoffDeps } from '@/lib/storeHandoffDeps';
import {
  handoffDisabled,
  handoffFailure,
  handoffJson,
  readHandoffBody,
} from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 10;

// お店の端末が送った tx を記録する (お客様の画面の完了表示を早める付帯情報・トークン必須)。
// 無認証の要求で本文を読まない: id の HMAC と端末のトークン (ヘッダ) を本文より先に確かめる (KV にも触れない)。
// 端末の要求だけを IP ごとに数えてから本文を読む (会計ごとに 1 回・作成の IP 上限と同じ 60 回/分)。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  const { id } = await params;
  const token = req.headers.get(STORE_HANDOFF_TOKEN_HEADER);
  const deps = handoffDeps();
  const denied = deviceAccessFailure(id, token, deps.mac);
  if (denied) return handoffFailure(denied);
  if (!(await checkIpRateLimit('store-handoff-tx', hashIpBucket(clientIp(req)), 60, 60))) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const parsed = await readHandoffBody(req);
  if (!parsed.ok) return parsed.res;
  const r = await recordHandoffTx(id, token, parsed.body, deps);
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
