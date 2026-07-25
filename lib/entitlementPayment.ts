// 期限付き利用権 (Pro / CSV パス等) の **加入処理エンジン** (server 専用)。店主が JPYC を FEE_RECEIVER
// へ送金 → txHash を自己申告 → on-chain で「セッション wallet → 受領アドレス・JPYC・tier 額以上」を
// 照合 → **支払い tx の block timestamp + 付与期間** を期限として決定論的に付与する。二重付与は txHash
// idempotency (KV nx・短ロック→結果昇格) で防止し、別 wallet による同 txHash 再提出は拒否する。
// 設計: plans/csv-pass.md (Pro: plans/pro-plan.md)。
//
// from 束縛が肝: from=session に固定するので、recover の forwarder→feeReceiver 転送 (from=forwarder)
// を加入支払いと**絶対に誤認しない**。各 tier の差分 (flag / used-key prefix / 価格 / 付与期間 / grant /
// revenue / logger prefix) は config で受け取り、core ロジック (ロック→検証→付与→昇格→収益) は共有する。
import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { createPublicClient, type Address, type Hex } from 'viem';
import { env } from '@/lib/env';
import { verifyJpycFeeOnChain } from '@/lib/feeVerify';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { kvSet, kvGet, kvDel, kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  CLAIM_PAYMENT_UNLESS_LEGACY_BILLING,
  legacyBillingPaymentKey,
  paymentClaimKey,
  paymentClaimPendingValue,
  paymentClaimResultValue,
  parsePaymentClaimKind,
  RELEASE_PAYMENT_CLAIM_IF_OWNED,
} from '@/lib/paymentClaim';

// idempotency は billing/settle と同方針: 短い処理ロック (nx) → 付与確定後に結果へ昇格。
const LOCK_TTL_SEC = 120;
const RESULT_TTL_SEC = 400 * 86_400;
const LOCK_MARKER = 'pending';
const RESULT_PREFIX = 'r:';

type EntitlementResult = { wallet: string; expiresAt: number };
export type EntitlementTier = 'pro' | 'csvpass';

// 認証済みセッション (requireSession の成功形)。route が requireSession を呼び address を渡す。
export type EntitlementSession = { address: Address };

export type EntitlementPaymentConfig = {
  /** 機能 flag (OFF なら認証/KV より前に 404)。 */
  enabled: boolean;
  /** FEE_RECEIVER 設定済か (未設定なら 503・未設定の宛先へ送金させない)。 */
  feeReceiverConfigured: boolean;
  /** idempotency ロック/結果 key の prefix (例 'pro:used:' / 'csvpass:used:')。tier 間で非共有。 */
  usedKeyPrefix: string;
  /** cross-tier txHash claim に保存する tier 名。 */
  tier: EntitlementTier;
  /** tier の最低額 (JPYC minor units・超過は受理するが付与は 1 期間のみ)。 */
  priceWei: bigint;
  /** 1 支払いで付与する時間 (ms)。target = blockTs*1000 + grantMs。 */
  grantMs: number;
  /** 付与関数 (atomic max・決定論)。route が grantPro / grantCsvPass を渡す。 */
  grant: (
    wallet: Address,
    targetExpiresAtMs: number,
  ) => Promise<{ ok: boolean; expiresAt: number }>;
  /** 収益記録 (txHash 単位冪等・失敗しても付与を壊さない)。route が record*Revenue を渡す。 */
  recordRevenue: (args: {
    wallet: Address;
    priceWei: bigint;
    chainId: number;
    txHash: string;
    paidAtMs: number;
  }) => Promise<void>;
  /** logger event の prefix (例 'pro.subscribe' / 'csvpass.subscribe')。観測上の tier 識別。 */
  logPrefix: string;
};

function parseResult(value: string | null): EntitlementResult | null {
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

function parseClaimedTier(value: string | null): EntitlementTier | null {
  const kind = parsePaymentClaimKind(value);
  return kind === 'pro' || kind === 'csvpass' ? kind : null;
}

/**
 * 加入処理の core。route 側は (1) body をパースし txHash/chainId を抽出、(2) requireSession を済ませて
 * から本関数を呼ぶ。flag-off (404) / feeReceiver 未設定 (503) も認証前ゲートとして本関数が扱う
 * (route から重複させない・ただし flag/feeReceiver の判定は config 経由で受ける)。
 */
export async function processEntitlementPayment(args: {
  txHash: string;
  chainId: number;
  session: EntitlementSession;
  config: EntitlementPaymentConfig;
}): Promise<NextResponse> {
  const { txHash, chainId, session, config } = args;

  const chain = chainObjectForId(chainId);
  const deployment = resolveDeployment('jpyc', chainId);
  if (!chain || !deployment) {
    return NextResponse.json(
      { ok: false, error: 'unsupported_chain' },
      { status: 400 },
    );
  }

  async function releaseClaim(usedKey: string, cause: string): Promise<void> {
    const del = await kvDel(usedKey);
    if (!del.ok) {
      logger.error(`${config.logPrefix}.release-failed`, {
        usedKey,
        cause,
        reason: del.reason,
      });
    }
  }

  let claimedKey = '';
  let claimedPending = '';
  let claimedThisRequest = false;
  let grantMade = false;

  async function releaseCrossTierClaim(cause: string): Promise<void> {
    if (!claimedThisRequest || grantMade) return;
    const del = await kvEval<number>(
      RELEASE_PAYMENT_CLAIM_IF_OWNED,
      [claimedKey],
      [claimedPending],
    );
    if (!del.ok) {
      logger.error(`${config.logPrefix}.claim-release-failed`, {
        claimedKey,
        cause,
        reason: del.reason,
      });
    }
    claimedThisRequest = false;
  }

  // 処理ロックを nx で取得 (chainId × txHash 単位)。取れなければ確定結果 (replay) か処理中 (409)。
  const usedKey = `${config.usedKeyPrefix}${chainId}:${txHash.toLowerCase()}`;
  const claim = await kvSet(usedKey, LOCK_MARKER, {
    nx: true,
    ttlSec: LOCK_TTL_SEC,
  });
  if (!claim.ok) {
    return NextResponse.json(
      { ok: false, error: 'kv_unavailable' },
      { status: 503 },
    );
  }
  if (claim.value !== 'OK') {
    const existing = await kvGet(usedKey);
    const prior = existing.ok ? parseResult(existing.value) : null;
    if (prior) {
      // cross-wallet replay 拒否: この txHash は別 wallet の加入に使用済み。付与しない。
      if (prior.wallet.toLowerCase() !== session.address.toLowerCase()) {
        logger.warn(`${config.logPrefix}.used-by-other`, {
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
      txHash: txHash as Hex,
      expected: {
        token: deployment.address,
        from: session.address, // from 束縛 (recover forwarder を加入支払いと誤認しない)
        to: env.feeReceiver,
        minValue: config.priceWei, // tier 額以上 (超過は受理するが付与は 1 期間のみ)
      },
    });

    if (!result.ok) {
      await releaseClaim(usedKey, result.reason); // 正しい tx で再提出可能に
      if (result.reason === 'rpc_error') {
        logger.error(`${config.logPrefix}.rpc-error`, {
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
      logger.warn(`${config.logPrefix}.verify-failed`, {
        wallet: session.address,
        chainId,
        reason: result.reason,
      });
      return NextResponse.json(
        { ok: false, error: 'insufficient_payment', reason: result.reason },
        { status: 400 },
      );
    }

    // 決定論的付与: 支払い tx の block timestamp + 付与期間。now() は使わない (retry 冪等の核心)。
    // blockNumber は verifyJpycFeeOnChain が receipt から載せている。欠落は RPC 不整合扱いで 503。
    if (result.blockNumber === undefined) {
      await releaseClaim(usedKey, 'missing-block-number');
      logger.error(`${config.logPrefix}.no-block-number`, {
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
      logger.error(`${config.logPrefix}.block-fetch-failed`, {
        wallet: session.address,
        chainId,
        detail: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json(
        { ok: false, error: 'verify_unavailable' },
        { status: 503 },
      );
    }
    const targetExpiresAtMs = blockTimestampMs + config.grantMs;

    claimedKey = paymentClaimKey(chainId, txHash);
    const owner = randomBytes(16).toString('base64url');
    claimedPending = paymentClaimPendingValue(config.tier, owner);
    const claimed = await kvEval<number>(
      CLAIM_PAYMENT_UNLESS_LEGACY_BILLING,
      [claimedKey, legacyBillingPaymentKey(chainId, txHash)],
      [claimedPending],
    );
    if (!claimed.ok) {
      await releaseClaim(usedKey, 'claimed-marker-unavailable');
      logger.error(`${config.logPrefix}.claim-failed`, {
        claimedKey,
        reason: claimed.reason,
      });
      return NextResponse.json(
        { ok: false, error: 'kv_unavailable' },
        { status: 503 },
      );
    }
    if (claimed.value === -1) {
      await releaseClaim(usedKey, 'used-by-legacy-billing');
      return NextResponse.json(
        { ok: false, error: 'already_processed' },
        { status: 409 },
      );
    }
    if (claimed.value === 0) {
      const existing = await kvGet(claimedKey);
      if (!existing.ok) {
        await releaseClaim(usedKey, 'claimed-marker-read-failed');
        logger.error(`${config.logPrefix}.claim-read-failed`, {
          claimedKey,
          reason: existing.reason,
        });
        return NextResponse.json(
          { ok: false, error: 'kv_unavailable' },
          { status: 503 },
        );
      }
      const claimedTier = parseClaimedTier(existing.value);
      if (claimedTier === config.tier) {
        // Same-tier marker: allow the existing per-tier replay/crash-repair path to continue.
      } else if (claimedTier) {
        await releaseClaim(usedKey, 'used-by-other-tier');
        logger.warn(`${config.logPrefix}.used-by-other-tier`, {
          wallet: session.address,
          chainId,
          claimedTier,
        });
        return NextResponse.json(
          { ok: false, error: 'used_by_other_tier' },
          { status: 400 },
        );
      } else {
        await releaseClaim(usedKey, 'claimed-marker-unparseable');
        return NextResponse.json(
          { ok: false, error: 'already_processed' },
          { status: 409 },
        );
      }
    } else if (claimed.value === 1) {
      claimedThisRequest = true;
    } else {
      await releaseClaim(usedKey, 'claimed-marker-invalid-result');
      return NextResponse.json(
        { ok: false, error: 'already_processed' },
        { status: 409 },
      );
    }

    const granted = await config.grant(session.address, targetExpiresAtMs);
    if (!granted.ok) {
      await releaseClaim(usedKey, 'grant-write-failed');
      await releaseCrossTierClaim('grant-write-failed');
      logger.error(`${config.logPrefix}.grant-failed`, {
        wallet: session.address,
        chainId,
        txHash,
      });
      return NextResponse.json(
        { ok: false, error: 'grant_failed' },
        { status: 503 },
      );
    }
    grantMade = true;

    // 初回 request と crash 後 same-tier retry のどちらも恒久結果へ昇格する。初期 claim 自体も
    // TTL 無しなので、昇格 KV 障害が entitlement 支払いを order/billing へ再利用可能にする波及を断つ。
    const claimPromote = await kvSet(
      claimedKey,
      paymentClaimResultValue(config.tier),
    );
    if (!claimPromote.ok) {
      logger.warn(`${config.logPrefix}.claim-promote-failed`, {
        claimedKey,
        reason: claimPromote.reason,
      });
    }

    // 付与確定 → ロックを結果へ昇格 (恒久 TTL・grant 先 wallet を保持して cross-wallet replay を拒否)。
    const promote = await kvSet(
      usedKey,
      RESULT_PREFIX +
        JSON.stringify({ wallet: session.address, expiresAt: granted.expiresAt }),
      { ttlSec: RESULT_TTL_SEC },
    );
    if (!promote.ok) {
      // 昇格失敗はロックが短命のまま失効しうるが、crash 後 retry が同 tx を再検証→再 grant し、
      // grant は atomic max で冪等なので二重 extend しない (settle 同型)。決済は壊さない。
      logger.warn(`${config.logPrefix}.promote-failed`, {
        usedKey,
        reason: promote.reason,
      });
    }

    // 収益記録 (FEE_RECEIVER 収入を recover 手数料/a1 利用料と会計分離・txHash 単位で冪等)。
    // 額は **実際に on-chain で受領した value** (超過分も正しく台帳に乗る・Codex P2)、計上時点は
    // **支払い tx の block timestamp** (遅延 claim でも正しい期に記録・Date.now() を使わない)。
    await config.recordRevenue({
      wallet: session.address,
      priceWei: result.value ?? config.priceWei,
      chainId,
      txHash,
      paidAtMs: blockTimestampMs,
    });

    logger.info(`${config.logPrefix}.granted`, {
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
    if (!grantMade) {
      await releaseClaim(usedKey, 'unexpected-error');
      await releaseCrossTierClaim('unexpected-error');
    }
    logger.error(`${config.logPrefix}.unexpected`, {
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
