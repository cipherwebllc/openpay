// モバイル注文「受注リレー」: 顧客の決済成功 webhook (openpay.checkout.success) を受け、
// txHash をオンチェーン検証して店主 (受取アドレス) の KV 受注リストへ追加する。
// SIWE 無し (顧客端末から発火) ゆえ、(1) @handle 束縛 (config.to===merchant)、(2) IP レート制限、
// (3) on-chain 検証 (from 非依存・to=merchant への実着金)、(4) txHash 冪等 (1 決済 1 注文) で守る。
// 受注は **advisory**: 実着金額を権威保存・商品/テーブルは顧客申告。flag OFF は 404 (本番 inert)。
// 設計: plans/swift-puzzling-sky.md。
import { receiptHasRelayEvidence, verifyOrderBinding } from '@/lib/order/orderBindingVerify';
import { recordMetric } from '@/lib/metrics';
import { NextResponse, after } from 'next/server';
import { createPublicClient, getAddress, isAddress, type Address, type Hex } from 'viem';
import { env, isMainnet } from '@/lib/env';
import {
  chainObjectForId,
  transportForChain,
} from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import {
  verifyJpycStandardFeePairOnChain,
  verifyJpycTransferToOnChain,
} from '@/lib/feeVerify';
import {
  kvSet,
  kvGet,
  kvDel,
  kvLpush,
  kvLrange,
  kvLtrim,
  kvExpire,
  kvEval,
  isKvConfigured,
} from '@/lib/kv';
import { checkRateLimit, checkReadRateLimit } from '@/lib/relay/relayGuards';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { clientIp } from '@/lib/net/ipHash';
import { anonymizeIp } from '@/lib/relay/relayRoute';
import { resolveHandle } from '@/lib/handleStore';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import {
  orderListKey,
  orderUsedKey,
  orderStatusPointerKey,
  parseStoredOrder,
  serializeOrder,
  sanitizeOrderItems,
  sanitizeOrderMemo,
  sanitizeTable,
  declaredItemsTotalMinor,
  evaluateOrderAmount,
  isTxHashLike,
  ORDER_DUST_FLOOR_WEI,
  ORDER_LIST_MAX,
  ORDER_LIST_TTL_SEC,
  ORDER_MARK_PENDING,
  ORDER_MARK_DONE,
  ORDER_PENDING_TTL_SEC,
  ORDER_ID_MAX,
  type StoredOrder,
} from '@/lib/orderRelay';
import { resolveStandardFeeConfig, standardFeeObligationFromReceipt } from '@/lib/order/orderFeeObligation';
import { agentTransactionKey, receiptHasAgentReservation } from '@/lib/order/agentOrderReservation';
import {
  legacyBillingPaymentKey,
  paymentClaimKey,
  paymentClaimResultValue,
} from '@/lib/paymentClaim';
import { isOrderTokenLike } from '@/lib/orderToken';
import { logger } from '@/lib/logger';
import { notifyPaymentReceived } from '@/lib/push/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

// body 上限 (逐次読みで打ち切る)。受注 payload は明細 (ORDER_ITEMS_MAX) + オプション名 + メモが
// 上限で、64KB あれば正当な注文は通る。money-path は不変 (追加の 413 分岐のみ)。
const ORDER_NOTIFY_BODY_MAX_BYTES = 64 * 1024;

// 過去の着金が新規注文へ流用される波及を減らす暫定 replay 緩和。支払い目的の証明ではない。
// canonical block 時刻で 30 分以内 (境界含む) とし、server 時計に対する未来ずれは 2 分まで許容する。
const ORDER_PAYMENT_MAX_AGE_MS = 30n * 60n * 1000n;
const ORDER_PAYMENT_FUTURE_TOLERANCE_MS = 2n * 60n * 1000n;

const AMOUNT_ADVISORY_BPS_CAP = 300;
const FEE_RECONCILE_RETRY_MS = [0, 1_000, 4_000, 10_000] as const;

// 既存 raw が残っているときだけ同じ位置へ置換し、Pro/CSV/billing と共有する fee tx の恒久
// claim も同一 Redis transaction 内で確定する。受注ボードの同時 fulfill 更新を失わず、1 本の
// fee tx が別注文・別商品へ波及する replay を断つ。list の位置と TTL は LPOS + LSET なので不変。
const RECONCILE_FEE =
  "local idx=redis.call('LPOS',KEYS[1],ARGV[1]); " +
  'if not idx then return 0 end; ' +
  "if redis.call('EXISTS',KEYS[2])==1 or redis.call('EXISTS',KEYS[3])==1 then return -1 end; " +
  "redis.call('SET',KEYS[2],ARGV[3]); " +
  "redis.call('LSET',KEYS[1],idx,ARGV[2]); return 1";

// 同一 receipt 内の fee を徴収済みとして保存する瞬間に、その txHash を用途横断 claim する。
// claim 確認と注文 LPUSH の間へ別注文 reconciliation が割り込んで同じ fee を二重充当する波及を
// Redis 1 transaction で断つ。既存 global/legacy claim があれば未収版を保存し badge を残す。
// Lua の runtime error は先行 write を rollback しないため、未収版 LPUSH→SET claim→徴収済み版
// LSET の順にする。どこで止まっても「未保存」または「未収表示が安全側に残る」だけにし、
// claim 無しの徴収済み注文や、claim だけ残る受注喪失へ波及させない。
const STORE_ORDER_WITH_INLINE_FEE_CLAIM =
  'local claimed=0; ' +
  "if redis.call('EXISTS',KEYS[2])==0 and redis.call('EXISTS',KEYS[3])==0 then " +
  "redis.call('LPUSH',KEYS[1],ARGV[1]); redis.call('SET',KEYS[2],ARGV[3]); " +
  "redis.call('LSET',KEYS[1],0,ARGV[2]); claimed=1; " +
  "else redis.call('LPUSH',KEYS[1],ARGV[1]); end; return claimed";

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

async function reconcileCollectedStandardFee(args: {
  merchant: Address;
  merchantTxHash: Hex;
  feeTxHash: Hex;
  chainId: number;
  token: Address;
  feeReceiver: Address;
  waitForOrder: boolean;
  checkReservation: boolean;
  publicClient: Parameters<
    typeof verifyJpycStandardFeePairOnChain
  >[0]['publicClient'];
}): Promise<void> {
  const listKey = orderListKey(args.merchant);
  let verifiedObligation: {
    merchantAmount: string;
    feeAmount: string;
    feeAlternateAmount?: string;
  } | null = null;
  let sawTarget = false;

  for (let attempt = 0; attempt < FEE_RECONCILE_RETRY_MS.length; attempt++) {
    const delayMs = FEE_RECONCILE_RETRY_MS[attempt];
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const list = await kvLrange(listKey, 0, ORDER_LIST_MAX - 1);
    if (!list.ok) {
      logger.warn('order.notify.fee_reconcile_kv_error', {
        reason: list.reason,
        op: 'read',
        chainId: args.chainId,
        merchant: args.merchant,
      });
      continue;
    }

    let oldRaw: string | null = null;
    let storedOrder: StoredOrder | null = null;
    for (const raw of list.value ?? []) {
      const parsed = parseStoredOrder(raw);
      if (
        parsed?.txHash.toLowerCase() === args.merchantTxHash.toLowerCase() &&
        parsed.feeUncollected === true
      ) {
        oldRaw = raw;
        storedOrder = parsed;
        break;
      }
    }
    // fresh/pending POST と保存処理の短い race は bounded retry し、既に解消済み・72h 失効は no-op。
    if (!oldRaw || !storedOrder) {
      if (!args.waitForOrder) return;
      continue;
    }
    sawTarget = true;

    // 保存時に server が storefront 設定 + on-chain merchant leg から確定した obligation を使う。
    // 後日の mode/feePayer/flag 変更で既存未収が減額・回収不能へ波及するのを断つ。旧/壊れレコードで
    // expected が無い場合は badge を消さず安全側 no-op（body や現在設定から推測して補完しない）。
    // Bound relay orders cannot borrow a later standard fee pair; preserve their verified commitment.
    if (!storedOrder.feeExpectedAmount || storedOrder.bindingDigest) return;
    const merchantValue = BigInt(storedOrder.amount);
    const expectedFee = BigInt(storedOrder.feeExpectedAmount);
    const alternateFee = storedOrder.feeExpectedAmountAlt
      ? BigInt(storedOrder.feeExpectedAmountAlt)
      : undefined;

    if (
      verifiedObligation === null ||
      storedOrder.amount !== verifiedObligation.merchantAmount ||
      storedOrder.feeExpectedAmount !== verifiedObligation.feeAmount ||
      storedOrder.feeExpectedAmountAlt !==
        verifiedObligation.feeAlternateAmount
    ) {
      const result = await verifyJpycStandardFeePairOnChain({
        publicClient: args.publicClient,
        includeReceiptLogs: args.checkReservation,
        merchantTxHash: args.merchantTxHash,
        feeTxHash: args.feeTxHash,
        expected: {
          token: args.token,
          merchant: args.merchant,
          merchantValue,
          feeReceiver: args.feeReceiver,
          feeMinValue: expectedFee,
          ...(alternateFee !== undefined
            ? { feeAlternateValue: alternateFee }
            : {}),
        },
      });
      if (!result.ok) {
        logger.warn('order.notify.fee_reconcile_verify_failed', {
          reason: result.reason,
          chainId: args.chainId,
          merchant: args.merchant,
        });
        if (
          (result.reason === 'rpc_error' ||
            result.reason === 'tx_not_found') &&
          attempt + 1 < FEE_RECONCILE_RETRY_MS.length
        ) {
          continue;
        }
        return;
      }
      if (args.checkReservation) {
        // Classify inside after(): relay evidence cannot borrow a standard fee pair, and RPC
        // latency/failure must not change the historical duplicate/processing response.
        if (receiptHasRelayEvidence(args.chainId, args.token, result.receiptLogs)) return;
        if (await receiptHasAgentReservation(args.chainId, args.token, result.receiptLogs) !== 'clear') return;
      }
      verifiedObligation = {
        merchantAmount: storedOrder.amount,
        feeAmount: storedOrder.feeExpectedAmount,
        ...(storedOrder.feeExpectedAmountAlt
          ? { feeAlternateAmount: storedOrder.feeExpectedAmountAlt }
          : {}),
      };
    }

    const reconciled: StoredOrder = { ...storedOrder };
    delete reconciled.feeUncollected;
    delete reconciled.feeExpectedAmount;
    delete reconciled.feeExpectedAmountAlt;
    const cas = await kvEval<number>(
      RECONCILE_FEE,
      [
        listKey,
        paymentClaimKey(args.chainId, args.feeTxHash),
        legacyBillingPaymentKey(args.chainId, args.feeTxHash),
      ],
      [
        oldRaw,
        serializeOrder(reconciled),
        paymentClaimResultValue('order'),
      ],
    );
    if (!cas.ok) {
      logger.warn('order.notify.fee_reconcile_kv_error', {
        reason: cas.reason,
        op: 'cas',
        chainId: args.chainId,
        merchant: args.merchant,
      });
      continue;
    }
    if (cas.value === 1) {
      logger.info('order.notify.fee_reconciled', {
        chainId: args.chainId,
        merchant: args.merchant,
      });
      return;
    }
    if (cas.value === -1) {
      logger.warn('order.notify.fee_reconcile_replay', {
        chainId: args.chainId,
        merchant: args.merchant,
      });
      return;
    }
    // cas.value === 0: 受注ボードの同時更新で oldRaw が消えた。再読込して最新状態を位置維持で更新する。
  }

  if (sawTarget) {
    logger.warn('order.notify.fee_reconcile_conflict', {
      reason: 'retry_exhausted',
      chainId: args.chainId,
      merchant: args.merchant,
    });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableOrderRelay) return fail('not_found', 404);

  // handle は URL query (?h=) で受ける。MobileOrderView が webhook URL に固定し、
  // CheckoutForm は payload を POST するだけ (CheckoutForm 無改変)。
  const handle = normalizeHandle(new URL(req.url).searchParams.get('h') ?? '');
  if (!handle) return fail('handle_required', 400);
  if (!isValidHandleFormat(handle)) return fail('invalid_handle', 400);

  const capped = await readJsonBodyCapped(req, ORDER_NOTIFY_BODY_MAX_BYTES);
  if (!capped.ok) {
    if (capped.reason === 'too_large') return fail('payload_too_large', 413);
    return fail('invalid_json', 400);
  }
  const body: unknown = capped.value;
  if (typeof body !== 'object' || body === null) return fail('invalid_body', 400);
  const o = body as Record<string, unknown>;

  // 入力検証。txHash は mode により payload キーが違う (relay/gasless=txHash・standard=merchantTxHash)。
  if (o.token !== 'jpyc') return fail('unsupported_token', 400);
  const txHashRaw = o.txHash ?? o.merchantTxHash;
  if (!isTxHashLike(txHashRaw)) return fail('invalid_tx', 400);
  if (typeof o.merchant !== 'string' || !isAddress(o.merchant)) return fail('invalid_merchant', 400);
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId)) return fail('invalid_chain', 400);
  const txHash = txHashRaw as Hex;
  const merchant = getAddress(o.merchant);
  const chainId = o.chainId;

  // 書込 authz: @handle 公開店舗のみ (config.to === merchant)。bare ?s= 経由は書けない。
  const resolved = await resolveHandle(handle);
  if (!resolved.ok) return fail('kv_unavailable', 503);
  const record = resolved.record;
  if (!record) return fail('handle_not_found', 404);
  let configTo: Address;
  try {
    configTo = getAddress(record.config.to);
  } catch {
    return fail('handle_not_found', 404);
  }
  if (configTo !== merchant) return fail('merchant_mismatch', 403);

  // 決済後の登録なので 5/分の枠は txHash ごと: 同じ NAT / 店内 Wi-Fi の別客の通知が
  // 互いの枠を消費して受注喪失へ波及するのを断つ。同一決済の連打は既存の制限で抑える。
  // txHash を替える flood が RPC/KV 負荷へ波及するのは寛容な subnet backstop (120/分) で断つ。
  // 両 limiter の storage 障害は既存 helper と同じ fail-open で受注登録へ波及させない。
  const ipPrefix = anonymizeIp(
    clientIp(req) ?? '',
  );
  const allowed = await checkRateLimit([`order:tx:${txHash.toLowerCase()}`]);
  if (!allowed) return fail('rate_limited', 429);
  if (!(await checkReadRateLimit(`order:${ipPrefix}`, 120, 60))) {
    return fail('rate_limited', 429);
  }

  const chain = chainObjectForId(chainId);
  const deployment = resolveDeployment('jpyc', chainId);
  if (!chain || !deployment) return fail('unsupported_chain', 400);
  const feeConfig = resolveStandardFeeConfig(record.storefront, chainId);
  const feeTxHash = isTxHashLike(o.feeTxHash)
    ? (o.feeTxHash as Hex)
    : null;

  const queueFeeReconciliation = (waitForOrder = false, checkReservation = false) => {
    if (!feeTxHash || !env.feeReceiverConfigured) return;
    after(async () => {
      try {
        const publicClient = createPublicClient({
          chain,
          transport: transportForChain(chainId),
        });
        if (checkReservation) {
          // Completed agent batches are fenced without another receipt RPC. Unknown public
          // claims are checked against the SAME merchant receipt used by fee verification below.
          const agent = await kvGet(agentTransactionKey(chainId, txHash));
          if (!agent.ok || agent.value !== null) return;
        }
        await reconcileCollectedStandardFee({
          merchant,
          merchantTxHash: txHash,
          feeTxHash,
          chainId,
          token: deployment.address,
          feeReceiver: getAddress(env.feeReceiver),
          waitForOrder,
          checkReservation,
          publicClient,
        });
      } catch (e) {
        // 手数料表示の付帯 reconciliation 障害を受注 webhook の既存応答へ波及させない。
        // 未収フラグを残す安全側に倒し、偽成功にせず observable にする。
        logger.warn('order.notify.fee_reconcile_unexpected', {
          reason: e instanceof Error ? e.message : String(e),
          chainId,
          merchant,
        });
      }
    });
  };

  // mainnet は KV 必須 (fail-open で未検証/未保存のまま素通りさせない)。
  if (isMainnet && !isKvConfigured()) return fail('kv_required', 503);

  // 冪等クレーム: **txHash のみ** (1 決済 1 注文)。**二段ロック** (P1-E/P1-F)。
  // ステージ1 = pending クレーム (短 TTL)。検証中に maxDuration タイムアウトで done 昇格前に強制終了しても
  // pending は ORDER_PENDING_TTL_SEC で自然失効する → 正規注文が最大 72h ロックされ消失する事故 (P1-F) を断つ。
  const usedKey = orderUsedKey(chainId, txHash);
  let existingMarker: 'done' | 'pending' | null = null;
  if (isKvConfigured()) {
    const claim = await kvSet(usedKey, ORDER_MARK_PENDING, {
      nx: true,
      ttlSec: ORDER_PENDING_TTL_SEC,
    });
    if (!claim.ok) return fail('kv_error', 503);
    if (claim.value === null) {
      // nx 失敗 = 既存マーカーあり。done (恒久) と pending (検証中) を読み分ける。
      const existing = await kvGet(usedKey);
      if (!existing.ok) return fail('kv_error', 503);
      existingMarker = existing.value === ORDER_MARK_DONE ? 'done' : 'pending';
      // Bind-less duplicates retain their historical immediate response under either rollout flag.
      // The after() task verifies reservation and relay evidence before any standard fee claim.
      if (!Object.hasOwn(o, 'bind')) {
        queueFeeReconciliation(existingMarker === 'pending', true);
        return existingMarker === 'done'
          ? NextResponse.json({ ok: true, duplicate: true }) : fail('processing', 409);
      }
    }
  }

  // A rejected replay must not delete another request's pending/done marker.
  const releaseClaim = async () => { if (!existingMarker) await kvDel(usedKey); };

  // 受注保存の確定フラグ (kvLpush 成功で true)。catch の解放判定に使う: 保存確定後は pending/done を
  // 消さない (done 昇格済を消すと同一 tx が二重注文になり得るため・下記 catch 参照)。
  let orderStored = false;

  try {
    // on-chain 検証 (from 非依存・to=merchant への実着金合計 ≥ dust フロア)。
    const publicClient = createPublicClient({ chain, transport: transportForChain(chainId) });
    const result = await verifyJpycTransferToOnChain({
      publicClient,
      txHash,
      includeReceiptLogs: true,
      expected: {
        token: deployment.address,
        to: merchant,
        minValue: ORDER_DUST_FLOOR_WEI,
        ...(env.feeReceiverConfigured
          ? { feeReceiver: getAddress(env.feeReceiver) }
          : {}),
      },
    });

    if (!result.ok) {
      // 検証不成立 → クレーム解放。rpc_error は retryable(503)・それ以外は顧客起因(422)。
      await releaseClaim();
      logger.warn('order.notify.verify_failed', { reason: result.reason, chainId, merchant });
      return fail(result.reason, result.reason === 'rpc_error' ? 503 : 422);
    }

    if (!existingMarker) {
      // optional な blockNumber の欠落で getBlock が latest を返し、過去の着金が鮮度検査を
      // 素通りする波及を断つ。receipt の block が特定できるまで再試行可能な検証失敗にする。
      if (result.blockNumber === undefined) {
        await releaseClaim();
        logger.warn('order.notify.verify_failed', { reason: 'rpc_error', chainId, merchant });
        return fail('rpc_error', 503);
      }

      let blockTimestamp: bigint;
      try {
        const block = await publicClient.getBlock({ blockNumber: result.blockNumber });
        blockTimestamp = block.timestamp;
      } catch {
        // block RPC 障害が未検証の受理や pending claim の居座りへ波及しないよう、既存の再試行契約へ戻す。
        await releaseClaim();
        logger.warn('order.notify.verify_failed', { reason: 'rpc_error', chainId, merchant });
        return fail('rpc_error', 503);
      }
      const paymentAgeMs = BigInt(Date.now()) - blockTimestamp * 1000n;
      // block が server 時計より大きく未来 = server 側の時計ずれ。本物の着金を恒久拒否 (422) へ
      // 波及させないよう、再試行可能な検証失敗に倒す。
      if (paymentAgeMs < -ORDER_PAYMENT_FUTURE_TOLERANCE_MS) {
        await releaseClaim();
        logger.warn('order.notify.verify_failed', {
          reason: 'clock_skew', chainId, merchant, ageSec: Number(paymentAgeMs) / 1000,
        });
        return fail('rpc_error', 503);
      }
      if (paymentAgeMs > ORDER_PAYMENT_MAX_AGE_MS) {
        await releaseClaim();
        logger.warn('order.notify.verify_failed', {
          reason: 'tx_too_old', chainId, merchant, ageSec: Number(paymentAgeMs) / 1000,
        });
        return fail('tx_too_old', 422);
      }
    }

    // Reuse the successful transfer verification's receipt, after A2a freshness checks.
    const reservation = await receiptHasAgentReservation(chainId, deployment.address, result.receiptLogs);
    if (reservation !== 'clear') {
      await releaseClaim();
      return fail(reservation === 'reserved' ? 'reserved_order' : 'storage_unavailable', reservation === 'reserved' ? 409 : 503);
    }

    const binding = verifyOrderBinding({
      body: o, handle, chainId, token: deployment.address, merchant, logs: result.receiptLogs,
      ...(env.feeReceiverConfigured ? { feeReceiver: getAddress(env.feeReceiver) } : {}),
    });
    if (!binding.ok) {
      await releaseClaim();
      return fail('order_binding_mismatch', 422);
    }
    if (existingMarker) {
      if (existingMarker === 'done' && binding.order) {
        // OFF's conflict warning is limited to the capped list; a trimmed unbound winner is undetectable here.
        const list = await kvLrange(orderListKey(merchant), 0, ORDER_LIST_MAX - 1);
        if (!list.ok) return fail('kv_error', 503);
        const conflict = (list.value ?? []).some((raw) => {
          const stored = parseStoredOrder(raw);
          return stored?.chainId === chainId && stored.txHash.toLowerCase() === txHash.toLowerCase() && stored.bindingMissing;
        });
        // OFF is observation only: never acknowledge the victim's opening as a registered order
        // when an unbound notification already won the transaction claim.
        if (conflict) return NextResponse.json({ ok: true, duplicate: true, bindingConflict: true });
      }
      // Only standard merchant/fee pairs are eligible; recover inline fees come from Settled.
      if (binding.kind === 'standard') queueFeeReconciliation(existingMarker === 'pending', true);
      return existingMarker === 'done'
        ? NextResponse.json({ ok: true, duplicate: true }) : fail('processing', 409);
    }
    const receiptValue = binding.value ?? result.value;
    const snapshot = binding.order;

    const orderId = snapshot?.orderId ?? (
      typeof o.orderId === 'string' && o.orderId.length > 0
        ? o.orderId.slice(0, ORDER_ID_MAX)
        : txHash); // orderId 無し時は txHash で代替 (一意)
    const items = snapshot?.items ?? sanitizeOrderItems(o.items);
    const declaredMinor = declaredItemsTotalMinor(items, deployment.decimals);
    const amountAdvisory = evaluateOrderAmount(
      declaredMinor,
      receiptValue,
      relayGasFeeValue(chainId),
      AMOUNT_ADVISORY_BPS_CAP,
    );

    const order: StoredOrder = {
      orderId,
      items,
      table: snapshot ? snapshot.description || null : sanitizeTable(o.description), // checkout description = テーブル番号ラベル (店内のみ)
      amount: receiptValue.toString(), // **実着金 (権威)** — recover は total−fee, free は total
      txHash,
      chainId,
      // **オンチェーン検証していない顧客申告値** (feeVerify は from を返さない・表示専用)。形式のみ検証。P1-D
      from: typeof o.from === 'string' && isAddress(o.from) ? getAddress(o.from) : '',
      ts: Date.now(),
      fulfilled: false,
    };
    if (binding.bindingMissing) order.bindingMissing = true;
    if (binding.digest) order.bindingDigest = binding.digest;
    if (amountAdvisory.mismatch) order.amountMismatch = true;
    if (amountAdvisory.unchecked) order.amountUnchecked = true;
    const feeObligation = standardFeeObligationFromReceipt({
      receiptValue,
      sameSourceFeeValue: binding.sameSourceFeeValue ?? result.sameSourceFeeValue,
      config: feeConfig,
    });
    // 店舗送金確定後の fee leg 失敗が受注欠落へ波及しないよう未収状態を additive に記録する。
    // 判定/額は body でなく公開 storefront 設定 + on-chain direct merchant leg のみから導く。
    if (feeObligation && !feeObligation.collectedInline) {
      order.feeUncollected = true;
      order.feeExpectedAmount = feeObligation.expected.toString();
      if (feeObligation.alternate !== undefined) {
        order.feeExpectedAmountAlt = feeObligation.alternate.toString();
      }
    }
    // 受取予定時刻 (任意・preorder・顧客申告=advisory 表示用・items/table と同じ寛容さ)。正の有限数かつ
    // **near-future 窓内** (now-1h 〜 now+14d) のみ保存。スロット/lastOrder との厳密照合はしない (advisory)
    // が、年 9999 等の極端値で受注ボードの表示を汚さないよう sane 窓外は drop する (clock skew に -1h)。
    const pickupAt = snapshot?.pickupAt ?? o.pickupAt;
    if (typeof pickupAt === 'number' && Number.isFinite(pickupAt)) {
      const at = Math.floor(pickupAt);
      const nowMs = Date.now();
      if (at > nowMs - 60 * 60 * 1000 && at < nowMs + 14 * 24 * 60 * 60 * 1000) {
        order.pickupAt = at;
      }
    }
    const customerMemo = snapshot?.customerMemo ?? sanitizeOrderMemo(o.customerMemo);
    if (customerMemo) order.customerMemo = customerMemo;

    if (isKvConfigured()) {
      const key = orderListKey(merchant);
      const save = feeObligation?.collectedInline
        ? await kvEval<number>(
            STORE_ORDER_WITH_INLINE_FEE_CLAIM,
            [
              key,
              paymentClaimKey(chainId, txHash),
              legacyBillingPaymentKey(chainId, txHash),
            ],
            [
              serializeOrder({
                ...order,
                feeUncollected: true,
                feeExpectedAmount: feeObligation.expected.toString(),
                ...(feeObligation.alternate !== undefined
                  ? {
                      feeExpectedAmountAlt:
                        feeObligation.alternate.toString(),
                    }
                  : {}),
              }),
              serializeOrder(order),
              paymentClaimResultValue('order'),
            ],
          )
        : await kvLpush(key, serializeOrder(order));
      if (!save.ok) {
        await releaseClaim(); // 保存できなければ pending クレームも戻す (リトライで再投入可能に)
        return fail('kv_error', 503);
      }
      if (feeObligation?.collectedInline && save.value !== 1) {
        order.feeUncollected = true;
        order.feeExpectedAmount = feeObligation.expected.toString();
        if (feeObligation.alternate !== undefined) {
          order.feeExpectedAmountAlt =
            feeObligation.alternate.toString();
        }
      }
      orderStored = true; // 受注は KV に確定。以降 pending クレームは消さない (下記 catch 参照)。
      // 月次メトリクス (運営ヒント・no-throw)。
      void recordMetric('order');
      // ステージ2 = pending → done 昇格 (恒久・TTL 上書きで EX を落とす)。**保存確定の後**に昇格するのが肝:
      // 逆順 (昇格→保存) だと昇格後に保存失敗した tx が恒久ブロックのまま永久喪失する (P1-F を悪化)。
      // 保存→昇格の順なら最悪でも「未昇格 pending の自然失効 → 再 POST で復旧」に倒れる (喪失より二重が安全)。
      const promote = await kvSet(usedKey, ORDER_MARK_DONE); // ttl 無し = 恒久ブロック (無期限リプレイ拒否)
      if (!promote.ok) {
        // finalize 失敗。受注は保存済ゆえ本体は止めない (fail-quiet) が、昇格漏れは pending 失効後の
        // 再 POST を許し二重注文になり得るため observable にする (掟13: 波及は断つが黙殺はしない)。
        logger.warn('order.notify.promote_failed', { reason: promote.reason, chainId, merchant });
      }
      await kvLtrim(key, 0, ORDER_LIST_MAX - 1); // 上限 200 (古いものから押し出し)
      await kvExpire(key, ORDER_LIST_TTL_SEC); // LTRIM は TTL を更新しないので毎回張り直す

      // 顧客向け「注文状況」の逆引きポインタ (flag ENABLE_ORDER_PICKUP)。顧客端末が生成した不可推測の
      // status トークン (43 文字 base64url) → 受注の所在 {merchant, chainId, txHash} を保存し、顧客が
      // /api/order/status?t=<token> で **自分の 1 注文の状態だけ** を読めるようにする (token は秘密=列挙不可)。
      // 受注本体は上で保存済 = ここは付帯処理。失敗しても受注/決済は成立するため握り (fail-quiet)、
      // nx で重複保存を避ける (1 token 1 注文)。flag OFF / token 無し / 不正形式では何もしない (inert)。
      const statusToken = snapshot?.statusToken ?? o.statusToken;
      if (env.enableOrderPickup && isOrderTokenLike(statusToken)) {
        const ptr = await kvSet(
          orderStatusPointerKey(statusToken),
          JSON.stringify({ merchant, chainId, txHash }),
          { ttlSec: ORDER_LIST_TTL_SEC, nx: true },
        );
        // 付帯処理ゆえ受注/決済は止めない (fail-quiet) が、失敗は黙殺しない: ポインタ未保存だと顧客の
        // /api/order/status が 404 (status リンクが無言で機能しない) になるため observable にする。
        // nx 衝突 (既存 token) は ok:true (value:null) で warn しない — 1 token 1 注文の正常系。
        if (!ptr.ok) {
          logger.warn('order.notify.pointer_failed', { reason: ptr.reason, chainId, merchant });
        }
      }
    }

    if (orderStored && env.enablePushNotify) {
      after(() => notifyPaymentReceived(merchant, 'order'));
    }
    if (
      orderStored &&
      feeObligation &&
      (!feeObligation.collectedInline ||
        // inline claim が既存用途と衝突した場合は未収版を保存したため、同梱 feeTxHash があれば
        // 通常 reconciliation を試す（同じ claim なら badge は安全側に残る）。
        order.feeUncollected === true)
    ) {
      queueFeeReconciliation();
    }

    logger.info('order.notify.stored', { chainId, merchant, amount: order.amount });
    return NextResponse.json({ ok: true, orderId });
  } catch (e) {
    // 検証/保存の途中で予期せぬ例外 → pending クレームを解放しリトライ可能に戻す。ただし **保存確定後
    // (orderStored) は解放しない**: done 昇格済の恒久ブロックを消すと同一 tx の二重注文を招くため
    // (掟13: 断つべき波及=検証失敗時のクレーム居座りのみ・保存済の冪等は保つ)。
    if (!orderStored) await releaseClaim();
    logger.error('order.notify.unexpected', {
      reason: e instanceof Error ? e.message : String(e),
      chainId,
      merchant,
    });
    return fail('internal_error', 503);
  }
}
