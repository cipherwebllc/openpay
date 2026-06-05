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
import {
  isEntitlementTier,
  TIER_PRICE_JPYC,
  type EntitlementTier,
} from '@/lib/billing';
import { verifyJpycFeeOnChain } from '@/lib/feeVerify';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { kvSet, kvGet, kvDel } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// RPC の getTransactionReceipt (viem 既定 timeout 10s) + KV を平台レベルで bound し、
// 遅延/ハングした RPC が関数スロットを長時間占有しないようにする。
export const maxDuration = 20;

// idempotency は 2 段階: まず短い「処理ロック」を nx で取り、付与確定後に「結果」へ昇格する。
//  - 処理ロック (LOCK_MARKER・短 TTL): 検証/付与の最中だけ他リクエストを弾く。maxDuration kill や
//    途中中断ではロックが自然失効するため、txHash が恒久 claim されたまま焼失することがない。
//  - 結果 (FEE_RESULT_PREFIX + JSON・恒久 TTL): 付与済を表す。同 txHash の再提出は再付与せず
//    この結果を replay で返す (満了の暗黙延長を防ぐ)。
const FEE_LOCK_TTL_SEC = 120;
const FEE_RESULT_TTL_SEC = 400 * 86_400;
const LOCK_MARKER = 'pending';
const FEE_RESULT_PREFIX = 'r:';

type FeeResult = { tier: EntitlementTier; expiresAt: number };

// claim 値が「確定結果」なら parse して返す (処理ロック中 / 不正値は null)。
function parseFeeResult(value: string | null): FeeResult | null {
  if (!value || !value.startsWith(FEE_RESULT_PREFIX)) return null;
  try {
    const o = JSON.parse(value.slice(FEE_RESULT_PREFIX.length)) as {
      tier?: unknown;
      expiresAt?: unknown;
    };
    if (
      isEntitlementTier(o.tier) &&
      typeof o.expiresAt === 'number' &&
      Number.isFinite(o.expiresAt)
    ) {
      return { tier: o.tier, expiresAt: o.expiresAt };
    }
  } catch {
    /* 不正な結果値は replay 不可として扱う */
  }
  return null;
}

// 処理ロックの解放。kvDel 自体が失敗すると当該 txHash は短 TTL の失効まで再提出が
// already_processed になるため、運用で気付けるよう key を error log に残す。
async function releaseClaim(usedKey: string, cause: string): Promise<void> {
  const del = await kvDel(usedKey);
  if (!del.ok) {
    logger.error('billing.fee.release-failed', { usedKey, cause, reason: del.reason });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableBilling) {
    return NextResponse.json({ ok: false, error: 'billing_disabled' }, { status: 404 });
  }
  // FEE_RECEIVER 未設定 (placeholder=burn) では検証しない。さもなくば burn への送金を
  // 「正当な利用料」と誤認して付与してしまう (mainnet は env で deploy 自体を停止)。
  if (!env.feeReceiverConfigured) {
    logger.error('billing.fee.misconfigured', { reason: 'fee_receiver_unset' });
    return NextResponse.json(
      { ok: false, error: 'billing_misconfigured' },
      { status: 503 },
    );
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

  // 処理ロックを nx で取得。取れなければ既存 = 確定結果 (replay) か処理中 (409)。
  const usedKey = `fee:used:${chainId}:${txHash.toLowerCase()}`;
  const claim = await kvSet(usedKey, LOCK_MARKER, {
    nx: true,
    ttlSec: FEE_LOCK_TTL_SEC,
  });
  if (!claim.ok) {
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  if (claim.value !== 'OK') {
    // 既に確定済 (結果あり) → 再付与せず同じ結果を replay。処理中 (ロックのみ) → 409。
    const existing = await kvGet(usedKey);
    const prior = existing.ok ? parseFeeResult(existing.value) : null;
    if (prior) {
      return NextResponse.json({
        ok: true,
        tier: prior.tier,
        expiresAt: prior.expiresAt,
        replay: true,
      });
    }
    return NextResponse.json({ ok: false, error: 'already_processed' }, { status: 409 });
  }

  // ロック取得後の処理は想定外 throw (RPC/transport 設定不備等) でも必ずロックを解放する。
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
        minValue: TIER_PRICE_JPYC[tier],
      },
    });

    if (!result.ok) {
      await releaseClaim(usedKey, result.reason); // release → 正しい tx で再提出可能に
      // RPC/transport 障害は顧客の誤 tx (tx_not_found 等) と区別し retryable + alert へ。
      if (result.reason === 'rpc_error') {
        logger.error('billing.fee.rpc-error', {
          wallet: session.address,
          chainId,
          tier,
        });
        return NextResponse.json(
          { ok: false, error: 'verify_unavailable' },
          { status: 503 },
        );
      }
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
    // 検証は通ったが利用権の永続化に失敗 (KV 書込 NG)。ロックを解放し 503。
    // 「支払い済なのに無付与」を防ぐ (正しい tx で再提出可能・ロックは短 TTL で失効)。
    if (!granted.ok) {
      await releaseClaim(usedKey, 'grant-write-failed');
      logger.error('billing.fee.grant-failed', {
        wallet: session.address,
        chainId,
        tier,
        txHash,
      });
      return NextResponse.json({ ok: false, error: 'grant_failed' }, { status: 503 });
    }

    // 付与確定 → ロックを結果へ昇格 (恒久 TTL)。以後の再提出は replay になり再付与しない。
    // 昇格失敗でも付与は済んでいる: ロックは FEE_LOCK_TTL_SEC で失効し、その後の再提出は
    // grant の max-merge が安全に吸収する (観測のため warn は残す)。
    const promote = await kvSet(
      usedKey,
      FEE_RESULT_PREFIX +
        JSON.stringify({ tier: granted.tier, expiresAt: granted.expiresAt }),
      { ttlSec: FEE_RESULT_TTL_SEC },
    );
    if (!promote.ok) {
      logger.warn('billing.fee.promote-failed', {
        usedKey,
        reason: promote.reason,
      });
    }
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
  } catch (e) {
    await releaseClaim(usedKey, 'unexpected-error');
    logger.error('billing.fee.unexpected', {
      wallet: session.address,
      chainId,
      tier,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { ok: false, error: 'verify_unavailable' },
      { status: 503 },
    );
  }
}
