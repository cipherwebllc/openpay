// SIWE nonce 発行。クライアントはこの nonce を含む EIP-4361 message を作って署名する。
// nonce は KV に SET NX EX で 1 回限り予約し、verify 時に DEL で atomic 消費 → replay 防止。
// KV 未設定なら replay 防御が成立しないため 503 (auth 機能を degrade)。
import { NextResponse } from 'next/server';
import { isKvConfigured, kvSet } from '@/lib/kv';
import { nonceKey, NONCE_TTL_SEC, newSiweNonce } from '@/lib/siwe';
import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  if (!isKvConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'kv_not_configured' },
      { status: 503 },
    );
  }
  if (!(await checkIpRateLimit('siwe-nonce', hashIp(clientIp(req)), 60, 60))) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  const nonce = newSiweNonce();
  const res = await kvSet(nonceKey(nonce), '1', { nx: true, ttlSec: NONCE_TTL_SEC });
  if (!res.ok || res.value !== 'OK') {
    // NX 衝突 (天文学的に稀) や KV エラー。安全側に倒して発行失敗を返す。
    // KV 障害はログインを止めるため Sentry に上げてアラート対象にする。
    logger.warn('siwe.nonce.issue_failed', {
      reason: res.ok ? 'nx_collision' : res.reason,
    });
    return NextResponse.json({ ok: false, error: 'nonce_issue_failed' }, { status: 503 });
  }
  return NextResponse.json({ ok: true, nonce });
}
