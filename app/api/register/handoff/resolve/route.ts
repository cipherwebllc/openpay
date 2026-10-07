import type { NextResponse } from 'next/server';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { resolveDeps } from '@/lib/storeHandoffDeps';
import { resolveStoreHandoff } from '@/lib/storeHandoffResolve';
import {
  handoffDisabled,
  handoffJson,
  readHandoffBody,
} from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 20;

// お店の端末で送る 1 件の結論 (支払い済み / 行われていない (証明つき) / 確認中) をチェーンだけで出す。
// 受け渡しのセッションに依存しない (お客様の画面が意図の値を送り、nonce はサーバが計算し直す)。
export async function POST(req: Request): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  if (!(await checkIpRateLimit('store-handoff-resolve', hashIpBucket(clientIp(req)), 30, 60))) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const parsed = await readHandoffBody(req);
  if (!parsed.ok) return parsed.res;
  const r = await resolveStoreHandoff(parsed.body, resolveDeps());
  return r.ok ? handoffJson(r) : handoffJson({ ok: false, error: r.error }, r.status);
}
