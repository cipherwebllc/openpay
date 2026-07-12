// モバイル注文「受注リレー」: 顧客の決済成功 webhook (openpay.checkout.success) を受け、
// txHash をオンチェーン検証して店主 (受取アドレス) の KV 受注リストへ追加する。
// SIWE 無し (顧客端末から発火) ゆえ、(1) @handle 束縛 (config.to===merchant)、(2) IP レート制限、
// (3) on-chain 検証 (from 非依存・to=merchant への実着金)、(4) txHash 冪等 (1 決済 1 注文) で守る。
// 受注は **advisory**: 実着金額を権威保存・商品/テーブルは顧客申告。flag OFF は 404 (本番 inert)。
// 設計: plans/swift-puzzling-sky.md。
import { NextResponse, after } from 'next/server';
import { createPublicClient, getAddress, isAddress, type Address, type Hex } from 'viem';
import { env, isMainnet } from '@/lib/env';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { verifyJpycTransferToOnChain } from '@/lib/feeVerify';
import {
  kvSet,
  kvGet,
  kvDel,
  kvLpush,
  kvLtrim,
  kvExpire,
  isKvConfigured,
} from '@/lib/kv';
import { checkRateLimit } from '@/lib/relay/relayGuards';
import { relayGasFeeValue } from '@/lib/relay/forwarderConfig';
import { anonymizeIp } from '@/lib/relay/relayRoute';
import { resolveHandle } from '@/lib/handleStore';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import {
  orderListKey,
  orderUsedKey,
  orderStatusPointerKey,
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
import { isOrderTokenLike } from '@/lib/orderToken';
import { logger } from '@/lib/logger';
import { notifyPaymentReceived } from '@/lib/push/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const AMOUNT_ADVISORY_BPS_CAP = 300;

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableOrderRelay) return fail('not_found', 404);

  // handle は URL query (?h=) で受ける。MobileOrderView が webhook URL に固定し、
  // CheckoutForm は payload を POST するだけ (CheckoutForm 無改変)。
  const handle = normalizeHandle(new URL(req.url).searchParams.get('h') ?? '');
  if (!handle) return fail('handle_required', 400);
  if (!isValidHandleFormat(handle)) return fail('invalid_handle', 400);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_json', 400);
  }
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

  // レート制限 (IP のみ): 単一クライアントの flood は弾くが、別客 (別 IP) の正当な注文は制限しない。
  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );
  const allowed = await checkRateLimit([`order:${ipPrefix}`]);
  if (!allowed) return fail('rate_limited', 429);

  const chain = chainObjectForId(chainId);
  const deployment = resolveDeployment('jpyc', chainId);
  if (!chain || !deployment) return fail('unsupported_chain', 400);

  // mainnet は KV 必須 (fail-open で未検証/未保存のまま素通りさせない)。
  if (isMainnet && !isKvConfigured()) return fail('kv_required', 503);

  // 冪等クレーム: **txHash のみ** (1 決済 1 注文)。**二段ロック** (P1-E/P1-F)。
  // ステージ1 = pending クレーム (短 TTL)。検証中に maxDuration タイムアウトで done 昇格前に強制終了しても
  // pending は ORDER_PENDING_TTL_SEC で自然失効する → 正規注文が最大 72h ロックされ消失する事故 (P1-F) を断つ。
  const usedKey = orderUsedKey(chainId, txHash);
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
      // done = 検証 + 保存済の恒久ブロック → 同一 txHash の無期限リプレイを永久拒否 (P1-E)。1 決済 1 注文。
      if (existing.value === ORDER_MARK_DONE) {
        return NextResponse.json({ ok: true, duplicate: true });
      }
      // pending 中 (または直前に失効/解放) = **まだ done でない** → 検証成功前の**偽 duplicate を返さない** (P2)。
      // 別 POST が検証中/リトライ可能な「処理中」を表す (client は pending 失効後に同一 txHash を再送可能)。
      return fail('processing', 409);
    }
  }

  // 受注保存の確定フラグ (kvLpush 成功で true)。catch の解放判定に使う: 保存確定後は pending/done を
  // 消さない (done 昇格済を消すと同一 tx が二重注文になり得るため・下記 catch 参照)。
  let orderStored = false;

  try {
    // on-chain 検証 (from 非依存・to=merchant への実着金合計 ≥ dust フロア)。
    const publicClient = createPublicClient({ chain, transport: transportForChain(chainId) });
    const result = await verifyJpycTransferToOnChain({
      publicClient,
      txHash,
      expected: { token: deployment.address, to: merchant, minValue: ORDER_DUST_FLOOR_WEI },
    });

    if (!result.ok) {
      // 検証不成立 → クレーム解放。rpc_error は retryable(503)・それ以外は顧客起因(422)。
      await kvDel(usedKey);
      logger.warn('order.notify.verify_failed', { reason: result.reason, chainId, merchant });
      return fail(result.reason, result.reason === 'rpc_error' ? 503 : 422);
    }

    const orderId =
      typeof o.orderId === 'string' && o.orderId.length > 0
        ? o.orderId.slice(0, ORDER_ID_MAX)
        : txHash; // orderId 無し時は txHash で代替 (一意)
    const items = sanitizeOrderItems(o.items);
    const declaredMinor = declaredItemsTotalMinor(items, deployment.decimals);
    const amountAdvisory = evaluateOrderAmount(
      declaredMinor,
      result.value,
      relayGasFeeValue(chainId),
      AMOUNT_ADVISORY_BPS_CAP,
    );

    const order: StoredOrder = {
      orderId,
      items,
      table: sanitizeTable(o.description), // checkout description = テーブル番号ラベル (店内のみ)
      amount: result.value.toString(), // **実着金 (権威)** — recover は total−fee, free は total
      txHash,
      chainId,
      // **オンチェーン検証していない顧客申告値** (feeVerify は from を返さない・表示専用)。形式のみ検証。P1-D
      from: typeof o.from === 'string' && isAddress(o.from) ? getAddress(o.from) : '',
      ts: Date.now(),
      fulfilled: false,
    };
    if (amountAdvisory.mismatch) order.amountMismatch = true;
    if (amountAdvisory.unchecked) order.amountUnchecked = true;
    // 受取予定時刻 (任意・preorder・顧客申告=advisory 表示用・items/table と同じ寛容さ)。正の有限数かつ
    // **near-future 窓内** (now-1h 〜 now+14d) のみ保存。スロット/lastOrder との厳密照合はしない (advisory)
    // が、年 9999 等の極端値で受注ボードの表示を汚さないよう sane 窓外は drop する (clock skew に -1h)。
    if (typeof o.pickupAt === 'number' && Number.isFinite(o.pickupAt)) {
      const at = Math.floor(o.pickupAt);
      const nowMs = Date.now();
      if (at > nowMs - 60 * 60 * 1000 && at < nowMs + 14 * 24 * 60 * 60 * 1000) {
        order.pickupAt = at;
      }
    }
    const customerMemo = sanitizeOrderMemo(o.customerMemo);
    if (customerMemo) order.customerMemo = customerMemo;

    if (isKvConfigured()) {
      const key = orderListKey(merchant);
      const push = await kvLpush(key, serializeOrder(order));
      if (!push.ok) {
        await kvDel(usedKey); // 保存できなければ pending クレームも戻す (リトライで再投入可能に)
        return fail('kv_error', 503);
      }
      orderStored = true; // 受注は KV に確定。以降 pending クレームは消さない (下記 catch 参照)。
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
      const statusToken = o.statusToken;
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

    logger.info('order.notify.stored', { chainId, merchant, amount: order.amount });
    return NextResponse.json({ ok: true, orderId });
  } catch (e) {
    // 検証/保存の途中で予期せぬ例外 → pending クレームを解放しリトライ可能に戻す。ただし **保存確定後
    // (orderStored) は解放しない**: done 昇格済の恒久ブロックを消すと同一 tx の二重注文を招くため
    // (掟13: 断つべき波及=検証失敗時のクレーム居座りのみ・保存済の冪等は保つ)。
    if (!orderStored) await kvDel(usedKey);
    logger.error('order.notify.unexpected', {
      reason: e instanceof Error ? e.message : String(e),
      chainId,
      merchant,
    });
    return fail('internal_error', 503);
  }
}
