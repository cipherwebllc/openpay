// 利用権の付与 (運営オペレーション)。既存の admin Bearer (requireAdminAuth) で保護。
// アルファ中は bypass で全開放のため通常は不要だが、bypass を切った運用 (= 利用権必須) で
// 30日権を手動付与する経路。self-serve 購入 (x402) は別フェーズ。
import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import {
  grantEntitlement,
  ENTITLEMENT_DEFAULT_DAYS,
  type EntitlementTier,
} from '@/lib/entitlement';
import { requireAdminAuth } from '../../log/payment/_auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
  const authErr = requireAdminAuth(req);
  if (authErr) return authErr;

  let body: { wallet?: unknown; tier?: unknown; days?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (typeof body.wallet !== 'string' || !isAddress(body.wallet)) {
    return NextResponse.json({ ok: false, error: 'invalid_wallet' }, { status: 400 });
  }
  // tier 既定は pro (旧 admin 付与=freee gate=pro 相当の後方互換)。
  const tier: EntitlementTier = body.tier === 'basic' ? 'basic' : 'pro';
  const days =
    typeof body.days === 'number' && body.days > 0
      ? Math.floor(body.days)
      : ENTITLEMENT_DEFAULT_DAYS;
  const wallet = getAddress(body.wallet);
  const granted = await grantEntitlement(wallet, tier, days);
  if (!granted.ok) {
    return NextResponse.json({ ok: false, error: 'grant_failed' }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    wallet,
    tier: granted.tier,
    days,
    expiresAt: granted.expiresAt,
  });
}
