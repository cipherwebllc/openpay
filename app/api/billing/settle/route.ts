// OpenPay 利用料 (a1) の月次清算 → fee-current 付与 (SIWE 必須)。
// 店主はその期間の利用料 (= 中継出来高 × 料率) を OpenPay 受領アドレス (env.feeReceiver) へ JPYC で
// 支払い (ガスレス relay でも standard でも可)、その txHash を提出する。サーバが (1) 当該 (店主×期間) の
// インボイス額をメーター (S1) + 料率 (S2) から算出し、(2) on-chain で「セッション wallet → 受領アドレス・
// JPYC・インボイス額以上」を照合し、成立すれば fee-current (S3) を延長する。二重付与は txHash
// idempotency (KV nx・lock→result 昇格) で防止。billing flag OFF では無効。設計: docs/plans/merchant-gasless-fee-a1.md (S4)。
import { NextResponse } from 'next/server';
import { createPublicClient, isHex, type Hex } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { grantFeeCurrent } from '@/lib/feeCurrent';
import { loadUsageInvoice } from '@/lib/billingMeter';
import { recordFeeRevenue } from '@/lib/feeRevenue';
import { previousPeriod, feeCoverageThrough } from '@/lib/feeGate';
import { verifyJpycFeeOnChain } from '@/lib/feeVerify';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { kvSet, kvGet, kvDel } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// idempotency は fee/verify と同方針: 短い処理ロック (nx) → 付与確定後に結果へ昇格。
const SETTLE_LOCK_TTL_SEC = 120;
const SETTLE_RESULT_TTL_SEC = 400 * 86_400;
const LOCK_MARKER = 'pending';
const RESULT_PREFIX = 'r:';

type SettleResult = { period: string; expiresAt: number };

function parseSettleResult(value: string | null): SettleResult | null {
  if (!value || !value.startsWith(RESULT_PREFIX)) return null;
  try {
    const o = JSON.parse(value.slice(RESULT_PREFIX.length)) as {
      period?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof o.period === 'string' &&
      typeof o.expiresAt === 'number' &&
      Number.isFinite(o.expiresAt)
    ) {
      return { period: o.period, expiresAt: o.expiresAt };
    }
  } catch {
    /* 不正な結果値は replay 不可 */
  }
  return null;
}

async function releaseClaim(usedKey: string, cause: string): Promise<void> {
  const del = await kvDel(usedKey);
  if (!del.ok) {
    logger.error('billing.settle.release-failed', {
      usedKey,
      cause,
      reason: del.reason,
    });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableUsageFee) {
    return NextResponse.json(
      { ok: false, error: 'billing_disabled' },
      { status: 404 },
    );
  }
  if (!env.feeReceiverConfigured) {
    logger.error('billing.settle.misconfigured', {
      reason: 'fee_receiver_unset',
    });
    return NextResponse.json(
      { ok: false, error: 'billing_misconfigured' },
      { status: 503 },
    );
  }

  const session = await requireSession();
  if (!session.ok) return session.response;

  let body: { txHash?: unknown; chainId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }

  const { txHash, chainId } = body;
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
    return NextResponse.json(
      { ok: false, error: 'invalid_chain' },
      { status: 400 },
    );
  }

  const chain = chainObjectForId(chainId);
  const deployment = resolveDeployment('jpyc', chainId);
  if (!chain || !deployment) {
    return NextResponse.json(
      { ok: false, error: 'unsupported_chain' },
      { status: 400 },
    );
  }

  // 清算対象は **サーバが決める前月** (= gate が参照する、閉じた課金対象期)。caller に period を
  // 選ばせない (任意の 0 円/低額期間を投げて current を得る・未払いを回避する悪用を断つ)。
  const period = previousPeriod(Date.now());
  const invoice = await loadUsageInvoice(period, session.address);

  // 請求 0 (アルファ料率 0% / 前月出来高 0) → そもそも gate は遮断しない (前月請求なし) ので付与不要。
  // ok を返すだけ (fee-current を与えないので、0 円期間で current を得る余地がない)。
  if (invoice.feeWei === 0n) {
    return NextResponse.json({
      ok: true,
      nothingDue: true,
      period,
      feeWei: '0',
    });
  }

  // 請求あり → txHash 必須。
  if (typeof txHash !== 'string' || !isHex(txHash) || txHash.length !== 66) {
    return NextResponse.json(
      { ok: false, error: 'invalid_txhash' },
      { status: 400 },
    );
  }

  // 処理ロックを nx で取得 (txHash 単位)。取れなければ確定結果 (replay) か処理中 (409)。
  const usedKey = `billing:settled:${chainId}:${txHash.toLowerCase()}`;
  const claim = await kvSet(usedKey, LOCK_MARKER, {
    nx: true,
    ttlSec: SETTLE_LOCK_TTL_SEC,
  });
  if (!claim.ok) {
    return NextResponse.json(
      { ok: false, error: 'kv_unavailable' },
      { status: 503 },
    );
  }
  if (claim.value !== 'OK') {
    const existing = await kvGet(usedKey);
    const prior = existing.ok ? parseSettleResult(existing.value) : null;
    if (prior) {
      return NextResponse.json({
        ok: true,
        period: prior.period,
        expiresAt: prior.expiresAt,
        replay: true,
      });
    }
    return NextResponse.json(
      { ok: false, error: 'already_processed' },
      { status: 409 },
    );
  }

  try {
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
        minValue: invoice.feeWei,
      },
    });

    if (!result.ok) {
      await releaseClaim(usedKey, result.reason); // 正しい tx で再提出可能に
      if (result.reason === 'rpc_error') {
        logger.error('billing.settle.rpc-error', {
          wallet: session.address,
          chainId,
          period,
        });
        return NextResponse.json(
          { ok: false, error: 'verify_unavailable' },
          { status: 503 },
        );
      }
      logger.warn('billing.settle.verify-failed', {
        wallet: session.address,
        chainId,
        period,
        reason: result.reason,
      });
      return NextResponse.json(
        { ok: false, error: result.reason },
        { status: 422 },
      );
    }

    const granted = await grantFeeCurrent(session.address, {
      period,
      txHash,
      expiresAt: feeCoverageThrough(period), // period 基準の決定的満了 → replay で二重延長しない
    });
    if (!granted.ok) {
      await releaseClaim(usedKey, 'grant-write-failed');
      logger.error('billing.settle.grant-failed', {
        wallet: session.address,
        chainId,
        period,
        txHash,
      });
      return NextResponse.json(
        { ok: false, error: 'grant_failed' },
        { status: 503 },
      );
    }

    // 付与確定 → ロックを結果へ昇格 (恒久 TTL)。以後の再提出は replay (再付与しない)。
    const promote = await kvSet(
      usedKey,
      RESULT_PREFIX + JSON.stringify({ period, expiresAt: granted.expiresAt }),
      { ttlSec: SETTLE_RESULT_TTL_SEC },
    );
    if (!promote.ok) {
      logger.warn('billing.settle.promote-failed', {
        usedKey,
        reason: promote.reason,
      });
    }
    // 収益台帳に入金を記録 (admin 収益確認/freee CSV/照合 用)。初回成功時のみここに到達する
    // (replay は上の claim 分岐で早期 return)。台帳書込失敗は決済を壊さない (内部で握り潰し)。
    await recordFeeRevenue({
      merchant: session.address,
      period,
      feeWei: invoice.feeWei,
      chainId,
      txHash,
      paidAtMs: Date.now(),
    });
    logger.info('billing.settle.verified', {
      wallet: session.address,
      chainId,
      period,
      txHash,
    });
    return NextResponse.json({
      ok: true,
      period,
      feeWei: invoice.feeWei.toString(),
      expiresAt: granted.expiresAt,
    });
  } catch (e) {
    await releaseClaim(usedKey, 'unexpected-error');
    logger.error('billing.settle.unexpected', {
      wallet: session.address,
      chainId,
      period,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { ok: false, error: 'verify_unavailable' },
      { status: 503 },
    );
  }
}
