// OpenPay 利用料 (a1) の月次清算 → fee-current 付与 (SIWE 必須)。
// 店主はその期間の利用料 (= 中継出来高 × 料率) を OpenPay 受領アドレス (env.feeReceiver) へ JPYC で
// 支払い (ガスレス relay でも standard でも可)、その txHash を提出する。サーバが (1) 当該 (店主×期間) の
// インボイス額をメーター (S1) + 料率 (S2) から算出し、(2) on-chain で「セッション wallet → 受領アドレス・
// JPYC・インボイス額以上」を照合し、成立すれば fee-current (S3) を延長する。二重付与は txHash
// idempotency (KV nx・lock→result 昇格) で防止。billing flag OFF では無効。設計: docs/plans/merchant-gasless-fee-a1.md (S4)。
import { NextResponse, after } from 'next/server';
import { createPublicClient, isHex, type Hex } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { grantFeeCurrent, markPeriodPaid } from '@/lib/feeCurrent';
import { loadUsageInvoice } from '@/lib/billingMeter';
import { recordFeeRevenue } from '@/lib/feeRevenue';
import {
  previousPeriod,
  feeCoverageThrough,
  owedCandidatePeriods,
} from '@/lib/feeGate';
import { usageFeeConfig } from '@/lib/usageFee';
import { verifyJpycFeeOnChain } from '@/lib/feeVerify';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { kvSet, kvGet, kvDel, kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  legacyBillingPaymentKey,
  paymentClaimKey,
  paymentClaimResultValue,
  RELEASE_PAYMENT_CLAIM_IF_OWNED,
} from '@/lib/paymentClaim';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// body 上限 (逐次読みで打ち切る)。受理するのは {txHash, chainId, period} の 3 項目のみ。
const BILLING_SETTLE_BODY_MAX_BYTES = 4 * 1024;

// idempotency は fee/verify と同方針: 短い処理ロック (nx) → 付与確定後に結果へ昇格。
const SETTLE_LOCK_TTL_SEC = 120;
const SETTLE_RESULT_TTL_SEC = 400 * 86_400;
const LOCK_MARKER = 'pending';
const RESULT_PREFIX = 'r:';

type SettleResult = { period: string; expiresAt: number };

function billingPaymentClaimValue(
  wallet: string,
  period: string,
): string {
  return `${paymentClaimResultValue('billing')}:${wallet.toLowerCase()}:${period}`;
}

function legacyBillingPaymentClaimValue(period: string): string {
  return `${paymentClaimResultValue('billing')}:legacy:${period}`;
}

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

  const capped = await readJsonBodyCapped(req, BILLING_SETTLE_BODY_MAX_BYTES);
  if (!capped.ok) {
    if (capped.reason === 'too_large') {
      return NextResponse.json(
        { ok: false, error: 'payload_too_large' },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'invalid_json' },
      { status: 400 },
    );
  }
  // 既存の分解代入・検証順序は不変に保つ (掟12: money-path は追加のみ)。
  const body = capped.value as {
    txHash?: unknown;
    chainId?: unknown;
    period?: unknown;
  };

  const { txHash, chainId, period: periodIn } = body;
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

  // 清算対象期間。未指定は従来どおりサーバが決める前月 (後方互換)。指定時は **lookback 内の閉じた
  // 期間のみ選択可** (古い未収を遡って清算する手段)。任意の 0 円/低額期間で current を得る悪用は、
  // 下の invoice.feeWei===0n → nothingDue 早期 return が引き続き防ぐ (grant もマーカーも起きない)。
  const nowMs = Date.now();
  let period: string;
  if (periodIn === undefined) {
    period = previousPeriod(nowMs);
  } else if (typeof periodIn !== 'string' || !/^\d{4}-\d{2}$/.test(periodIn)) {
    return NextResponse.json(
      { ok: false, error: 'period_out_of_range' },
      { status: 400 },
    );
  } else {
    // 検証: startPeriod 以上・前月以下・lookback (12 か月) の候補範囲内。owedCandidatePeriods が
    // この閉区間の単一ソース (ゲート/invoice と共有)。範囲外 (未来/古すぎ/未点灯) は 400。
    const candidates = owedCandidatePeriods(nowMs, usageFeeConfig().startPeriod);
    if (!candidates.includes(periodIn)) {
      return NextResponse.json(
        { ok: false, error: 'period_out_of_range' },
        { status: 400 },
      );
    }
    period = periodIn;
  }
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
  const usedKey = legacyBillingPaymentKey(chainId, txHash);
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
      after(async () => {
        // 旧 result に存在しない payer を current session から補い、別 wallet の支払いとして
        // global claim へ誤帰属させる波及を断つ。legacy replay は period だけの marker に固定する。
        const claimValue = legacyBillingPaymentClaimValue(prior.period);
        const backfill = await kvSet(
          paymentClaimKey(chainId, txHash),
          claimValue,
          { nx: true },
        );
        // legacy settled tx の global backfill 障害を既存 replay 応答へ波及させず、移行漏れは observable にする。
        if (!backfill.ok) {
          logger.warn('billing.settle.global-claim-backfill-failed', {
            chainId,
            reason: backfill.reason,
          });
        } else if (backfill.value === null) {
          const existingGlobal = await kvGet(
            paymentClaimKey(chainId, txHash),
          );
          if (!existingGlobal.ok || existingGlobal.value !== claimValue) {
            logger.warn('billing.settle.global-claim-backfill-failed', {
              chainId,
              reason: existingGlobal.ok
                ? 'claim_conflict'
                : existingGlobal.reason,
            });
          }
        }
      });
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

  const globalClaimKey = paymentClaimKey(chainId, txHash);
  const globalClaimValue = billingPaymentClaimValue(
    session.address,
    period,
  );
  let globalClaimedThisRequest = false;
  let billingGrantMade = false;

  async function releaseGlobalClaim(cause: string): Promise<void> {
    if (!globalClaimedThisRequest || billingGrantMade) return;
    const del = await kvEval<number>(
      RELEASE_PAYMENT_CLAIM_IF_OWNED,
      [globalClaimKey],
      [globalClaimValue],
    );
    if (!del.ok) {
      logger.error('billing.settle.global-claim-release-failed', {
        globalClaimKey,
        cause,
        reason: del.reason,
      });
    }
    globalClaimedThisRequest = false;
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

    // on-chain 検証後、付与前に Pro/CSV/order と共有する恒久 claim を NX 取得する。
    // 同じ billing wallet+period の値だけは crash/retry として続行し、他用途・他請求への二重利用を断つ。
    const globalClaim = await kvSet(globalClaimKey, globalClaimValue, {
      nx: true,
    });
    if (!globalClaim.ok) {
      await releaseClaim(usedKey, 'global-claim-unavailable');
      logger.error('billing.settle.global-claim-failed', {
        globalClaimKey,
        reason: globalClaim.reason,
      });
      return NextResponse.json(
        { ok: false, error: 'kv_unavailable' },
        { status: 503 },
      );
    }
    if (globalClaim.value === null) {
      const existing = await kvGet(globalClaimKey);
      if (!existing.ok) {
        await releaseClaim(usedKey, 'global-claim-read-failed');
        return NextResponse.json(
          { ok: false, error: 'kv_unavailable' },
          { status: 503 },
        );
      }
      if (existing.value !== globalClaimValue) {
        await releaseClaim(usedKey, 'global-claim-conflict');
        return NextResponse.json(
          { ok: false, error: 'already_processed' },
          { status: 409 },
        );
      }
    } else {
      globalClaimedThisRequest = true;
    }

    const granted = await grantFeeCurrent(session.address, {
      period,
      txHash,
      expiresAt: feeCoverageThrough(period), // period 基準の決定的満了 → replay で二重延長しない
    });
    if (!granted.ok) {
      await releaseClaim(usedKey, 'grant-write-failed');
      await releaseGlobalClaim('grant-write-failed');
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
    billingGrantMade = true;

    // 期間別「支払い済み」マーカーを記録する。古い期間の清算では expiresAt が過去で fee-current は
    // 付かない (= 現行カバレッジは買えない・これが正しい挙動) ため、関所ゲートが「この期間はもう
    // 払った」と認識する唯一の手段がこのマーカー。書込失敗は grant-write-failed と同じ回復則:
    // releaseClaim + 503 で、同じ txHash の再提出で再試行できる (二重支払いは起きない)。
    const marked = await markPeriodPaid(session.address, period, txHash);
    if (!marked.ok) {
      await releaseClaim(usedKey, 'paid-marker-write-failed');
      // fee-current は既に付与済みなので global claim は恒久維持する。同じ billing
      // wallet+period の retry だけを許し、Pro/CSV/order への二重利用波及を断つ。
      logger.error('billing.settle.paid-marker-failed', {
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
    await releaseGlobalClaim('unexpected-error');
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
