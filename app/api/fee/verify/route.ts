// JPYC 利用料の自己申告検証 → 利用権の自動付与 (SIWE 必須)。
// 店主が tier 額の JPYC を OpenPay 受領アドレス (env.feeReceiver) へ送金し、その txHash を提出。
// サーバが on-chain で「セッション wallet → 受領アドレス・JPYC・tier 額以上」を照合し、成立すれば
// 30 日 tier を付与する。二重付与は txHash idempotency (KV nx) で防止。billing flag OFF では無効。
import { NextResponse } from 'next/server';
import { createPublicClient, isHex, type Hex } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import {
  grantEntitlement,
  ENTITLEMENT_DEFAULT_DAYS,
} from '@/lib/entitlement';
import { isEntitlementTier, TIER_PRICE_JPYC } from '@/lib/billing';
import { verifyJpycFeeOnChain } from '@/lib/feeVerify';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { kvSet, kvDel } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 利用権 (~30日) より十分長く保持し、同 txHash の再利用を恒久的に拒否する。
const FEE_USED_TTL_SEC = 400 * 86_400;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableBilling) {
    return NextResponse.json({ ok: false, error: 'billing_disabled' }, { status: 404 });
  }

  const session = await requireSession();
  if (!session.ok) return session.response;

  let body: { txHash?: unknown; chainId?: unknown; tier?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const { txHash, chainId, tier } = body;
  if (typeof txHash !== 'string' || !isHex(txHash) || txHash.length !== 66) {
    return NextResponse.json({ ok: false, error: 'invalid_txhash' }, { status: 400 });
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
    return NextResponse.json({ ok: false, error: 'invalid_chain' }, { status: 400 });
  }
  if (!isEntitlementTier(tier)) {
    return NextResponse.json({ ok: false, error: 'invalid_tier' }, { status: 400 });
  }

  const chain = chainObjectForId(chainId);
  const deployment = resolveDeployment('jpyc', chainId);
  if (!chain || !deployment) {
    return NextResponse.json({ ok: false, error: 'unsupported_chain' }, { status: 400 });
  }

  // 二重付与防止: txHash を nx で claim。既に使用済なら 409。verify 失敗時は release し再試行可。
  const usedKey = `fee:used:${chainId}:${txHash.toLowerCase()}`;
  const claim = await kvSet(usedKey, '1', { nx: true, ttlSec: FEE_USED_TTL_SEC });
  if (!claim.ok) {
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  if (claim.value !== 'OK') {
    return NextResponse.json({ ok: false, error: 'already_processed' }, { status: 409 });
  }

  const publicClient = createPublicClient({
    chain,
    transport: transportForChain(chainId),
  });
  const result = await verifyJpycFeeOnChain({
    publicClient,
    txHash,
    expected: {
      token: deployment.address,
      from: session.address,
      to: env.feeReceiver,
      minValue: TIER_PRICE_JPYC[tier],
    },
  });

  if (!result.ok) {
    await kvDel(usedKey); // release → 正しい tx で再提出可能に
    logger.warn('billing.fee.verify-failed', {
      wallet: session.address,
      chainId,
      tier,
      reason: result.reason,
    });
    return NextResponse.json({ ok: false, error: result.reason }, { status: 422 });
  }

  const granted = await grantEntitlement(
    session.address,
    tier,
    ENTITLEMENT_DEFAULT_DAYS,
  );
  logger.info('billing.fee.verified', {
    wallet: session.address,
    chainId,
    tier: granted.tier,
    txHash,
  });
  return NextResponse.json({
    ok: true,
    tier: granted.tier,
    expiresAt: granted.expiresAt,
  });
}
