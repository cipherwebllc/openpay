// OpenPay Pro (月額固定 ¥500=500 JPYC の前払いサブスク) の加入 API (SIWE 必須・POST)。
// 店主が 500 JPYC を FEE_RECEIVER へ送金 → その txHash を提出する。サーバが (1) on-chain で
// 「セッション wallet → 受領アドレス・JPYC・500 JPYC 以上」を照合し、(2) 支払い tx の block
// timestamp + 30日 を Pro 期限として **決定論的** に付与する。二重付与は txHash idempotency
// (KV nx・短ロック→結果昇格) で防止し、別 wallet による同 txHash 再提出は拒否する。
// Pro flag OFF では 404 (認証/KV より前)。設計: plans/pro-plan.md。
//
// from 束縛が肝: from=session に固定するので、recover の forwarder→feeReceiver 転送
// (from=forwarder) を Pro 支払いと**絶対に誤認しない**。
import { NextResponse } from 'next/server';
import { createPublicClient, isHex, type Hex } from 'viem';
import { requireSession } from '../../auth/siwe/_session';
import { env } from '@/lib/env';
import { grantPro, proPriceWei, PRO_GRANT_MS } from '@/lib/proPlan';
import { verifyJpycFeeOnChain } from '@/lib/feeVerify';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { kvSet, kvGet, kvDel } from '@/lib/kv';
import { recordProRevenue } from '@/lib/proRevenue';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// idempotency は billing/settle と同方針: 短い処理ロック (nx) → 付与確定後に結果へ昇格。
const PRO_LOCK_TTL_SEC = 120;
const PRO_RESULT_TTL_SEC = 400 * 86_400;
const LOCK_MARKER = 'pending';
const RESULT_PREFIX = 'r:';

type ProResult = { wallet: string; expiresAt: number };

function parseProResult(value: string | null): ProResult | null {
  if (!value || !value.startsWith(RESULT_PREFIX)) return null;
  try {
    const o = JSON.parse(value.slice(RESULT_PREFIX.length)) as {
      wallet?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof o.wallet === 'string' &&
      typeof o.expiresAt === 'number' &&
      Number.isFinite(o.expiresAt)
    ) {
      return { wallet: o.wallet, expiresAt: o.expiresAt };
    }
  } catch {
    /* 不正な結果値は replay 不可 */
  }
  return null;
}

async function releaseClaim(usedKey: string, cause: string): Promise<void> {
  const del = await kvDel(usedKey);
  if (!del.ok) {
    logger.error('pro.subscribe.release-failed', {
      usedKey,
      cause,
      reason: del.reason,
    });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  // flag-off は認証/KV より前に 404 (billing/invoice と同型・inert を最優先)。
  if (!env.enablePro) {
    return NextResponse.json(
      { ok: false, error: 'pro_disabled' },
      { status: 404 },
    );
  }
  // FEE_RECEIVER 未設定なら 503 (未設定の宛先へ 500 JPYC を送らせない・settle と同型)。
  if (!env.feeReceiverConfigured) {
    logger.error('pro.subscribe.misconfigured', {
      reason: 'fee_receiver_unset',
    });
    return NextResponse.json(
      { ok: false, error: 'pro_misconfigured' },
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
  if (typeof txHash !== 'string' || !isHex(txHash) || txHash.length !== 66) {
    return NextResponse.json(
      { ok: false, error: 'invalid_txhash' },
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

  // 処理ロックを nx で取得 (chainId × txHash 単位)。取れなければ確定結果 (replay) か処理中 (409)。
  const usedKey = `pro:used:${chainId}:${txHash.toLowerCase()}`;
  const claim = await kvSet(usedKey, LOCK_MARKER, {
    nx: true,
    ttlSec: PRO_LOCK_TTL_SEC,
  });
  if (!claim.ok) {
    return NextResponse.json(
      { ok: false, error: 'kv_unavailable' },
      { status: 503 },
    );
  }
  if (claim.value !== 'OK') {
    const existing = await kvGet(usedKey);
    const prior = existing.ok ? parseProResult(existing.value) : null;
    if (prior) {
      // cross-wallet replay 拒否: この txHash は別 wallet の加入に使用済み。付与しない。
      if (prior.wallet.toLowerCase() !== session.address.toLowerCase()) {
        logger.warn('pro.subscribe.used-by-other', {
          wallet: session.address,
          chainId,
        });
        return NextResponse.json(
          { ok: false, error: 'used_by_other_wallet' },
          { status: 400 },
        );
      }
      // same-wallet replay: 格納済み expiresAt をそのまま返す (再課金/再 extend なし)。
      return NextResponse.json({
        ok: true,
        wallet: prior.wallet,
        expiresAt: prior.expiresAt,
        replay: true,
      });
    }
    // 結果未昇格 (処理中・短ロックのみ)。
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
        from: session.address, // from 束縛 (recover forwarder を Pro 支払いと誤認しない)
        to: env.feeReceiver,
        minValue: proPriceWei, // 500 JPYC 以上 (超過は受理するが付与は 30日 1 期間のみ)
      },
    });

    if (!result.ok) {
      await releaseClaim(usedKey, result.reason); // 正しい tx で再提出可能に
      if (result.reason === 'rpc_error') {
        logger.error('pro.subscribe.rpc-error', {
          wallet: session.address,
          chainId,
        });
        return NextResponse.json(
          { ok: false, error: 'verify_unavailable' },
          { status: 503 },
        );
      }
      if (result.reason === 'tx_not_found') {
        // 未マイニング/未伝播。再送金させず同 txHash で再試行を促す (retryable)。
        return NextResponse.json(
          { ok: false, error: 'tx_not_found' },
          { status: 202 },
        );
      }
      if (result.reason === 'tx_reverted') {
        return NextResponse.json(
          { ok: false, error: 'tx_reverted' },
          { status: 400 },
        );
      }
      // no_matching_transfer / amount_too_low → 支払い不成立 (額不足・別 from/to/token)。
      logger.warn('pro.subscribe.verify-failed', {
        wallet: session.address,
        chainId,
        reason: result.reason,
      });
      return NextResponse.json(
        { ok: false, error: 'insufficient_payment', reason: result.reason },
        { status: 400 },
      );
    }

    // 決定論的付与: 支払い tx の block timestamp + 30日。now() は使わない (retry 冪等の核心)。
    // blockNumber は verifyJpycFeeOnChain が receipt から載せている。欠落は RPC 不整合扱いで 503。
    if (result.blockNumber === undefined) {
      await releaseClaim(usedKey, 'missing-block-number');
      logger.error('pro.subscribe.no-block-number', {
        wallet: session.address,
        chainId,
        txHash,
      });
      return NextResponse.json(
        { ok: false, error: 'verify_unavailable' },
        { status: 503 },
      );
    }
    let blockTimestampMs: number;
    try {
      const block = await publicClient.getBlock({
        blockNumber: result.blockNumber,
      });
      blockTimestampMs = Number(block.timestamp) * 1000;
      if (!Number.isFinite(blockTimestampMs) || blockTimestampMs <= 0) {
        throw new Error('invalid_block_timestamp');
      }
    } catch (e) {
      await releaseClaim(usedKey, 'block-fetch-failed');
      logger.error('pro.subscribe.block-fetch-failed', {
        wallet: session.address,
        chainId,
        detail: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json(
        { ok: false, error: 'verify_unavailable' },
        { status: 503 },
      );
    }
    const targetExpiresAtMs = blockTimestampMs + PRO_GRANT_MS;

    const granted = await grantPro(session.address, targetExpiresAtMs);
    if (!granted.ok) {
      await releaseClaim(usedKey, 'grant-write-failed');
      logger.error('pro.subscribe.grant-failed', {
        wallet: session.address,
        chainId,
        txHash,
      });
      return NextResponse.json(
        { ok: false, error: 'grant_failed' },
        { status: 503 },
      );
    }

    // 付与確定 → ロックを結果へ昇格 (恒久 TTL・grant 先 wallet を保持して cross-wallet replay を拒否)。
    const promote = await kvSet(
      usedKey,
      RESULT_PREFIX +
        JSON.stringify({ wallet: session.address, expiresAt: granted.expiresAt }),
      { ttlSec: PRO_RESULT_TTL_SEC },
    );
    if (!promote.ok) {
      // 昇格失敗はロックが短命のまま失効しうるが、crash 後 retry が同 tx を再検証→再 grant し、
      // grant は atomic max で冪等なので二重 extend しない (settle 同型)。決済は壊さない。
      logger.warn('pro.subscribe.promote-failed', {
        usedKey,
        reason: promote.reason,
      });
    }

    // 収益記録 (FEE_RECEIVER 収入を recover 手数料/a1 利用料と会計分離・txHash 単位で冪等)。
    // 額は **実際に on-chain で受領した value** (超過分も正しく台帳に乗る・Codex P2)、計上時点は
    // **支払い tx の block timestamp** (遅延 claim でも正しい期に記録・Date.now() を使わない)。
    await recordProRevenue({
      wallet: session.address,
      priceWei: result.value ?? proPriceWei,
      chainId,
      txHash,
      paidAtMs: blockTimestampMs,
    });

    logger.info('pro.subscribe.granted', {
      wallet: session.address,
      chainId,
      txHash,
    });
    return NextResponse.json({
      ok: true,
      wallet: session.address,
      expiresAt: granted.expiresAt,
    });
  } catch (e) {
    await releaseClaim(usedKey, 'unexpected-error');
    logger.error('pro.subscribe.unexpected', {
      wallet: session.address,
      chainId,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { ok: false, error: 'verify_unavailable' },
      { status: 503 },
    );
  }
}
