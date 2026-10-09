import type { NextResponse } from 'next/server';
import { isAddress } from 'viem';
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
//
// 回数制限は二段: IP ごと 60 回/分 (本文の前) → 同じ IP の中で店 (受取先) ごと 30 回/分 (本文の後)。店の全レジが同じ
// 公開 IP を使っても混雑時に作れなくならず (作れないと店員は利用料のかかる「通常の QR」に切り替える)、同じ IP の
// 別の店の混雑にも巻き込まれない。店ごとの枠は IP と組にする: 受取先だけで数えると、公開されている受取先を
// 第三者が別の IP から名指しして作り続け、その店の QR を作れなくできてしまう。
export async function POST(req: Request): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  const ipBucket = hashIpBucket(clientIp(req));
  if (!(await checkIpRateLimit('store-handoff-create', ipBucket, 60, 60))) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const parsed = await readHandoffBody(req);
  if (!parsed.ok) return parsed.res;
  const merchant = parsed.body.merchant;
  // 受取先の形が違う本文は数えない (作成が 400 を返す)。
  if (
    typeof merchant === 'string' &&
    isAddress(merchant, { strict: false }) &&
    !(await checkIpRateLimit(
      'store-handoff-create-merchant',
      ipBucket === null ? null : `${ipBucket}:${merchant.toLowerCase()}`,
      30,
      60,
    ))
  ) {
    return handoffJson({ ok: false, error: 'rate_limited' }, 429);
  }
  const r = await createHandoffSession(parsed.body, handoffDeps());
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
