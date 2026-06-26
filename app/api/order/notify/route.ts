// モバイル注文「受注リレー」: 顧客の決済成功 webhook (openpay.checkout.success) を受け、
// txHash をオンチェーン検証して店主 (受取アドレス) の KV 受注リストへ追加する。
// SIWE 無し (顧客端末から発火) ゆえ、(1) @handle 束縛 (config.to===merchant)、(2) IP レート制限、
// (3) on-chain 検証 (from 非依存・to=merchant への実着金)、(4) txHash 冪等 (1 決済 1 注文) で守る。
// 受注は **advisory**: 実着金額を権威保存・商品/テーブルは顧客申告。flag OFF は 404 (本番 inert)。
// 設計: plans/swift-puzzling-sky.md。
import { NextResponse } from 'next/server';
import { createPublicClient, getAddress, isAddress, type Address, type Hex } from 'viem';
import { env, isMainnet } from '@/lib/env';
import { chainObjectForId, transportForChain } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { verifyJpycTransferToOnChain } from '@/lib/feeVerify';
import {
  kvSet,
  kvDel,
  kvLpush,
  kvLtrim,
  kvExpire,
  isKvConfigured,
} from '@/lib/kv';
import { checkRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';
import { resolveHandle } from '@/lib/handleStore';
import { normalizeHandle } from '@/lib/handle';
import {
  orderListKey,
  orderUsedKey,
  orderStatusPointerKey,
  serializeOrder,
  sanitizeOrderItems,
  sanitizeTable,
  isTxHashLike,
  ORDER_DUST_FLOOR_WEI,
  ORDER_LIST_MAX,
  ORDER_LIST_TTL_SEC,
  ORDER_USED_TTL_SEC,
  ORDER_ID_MAX,
  type StoredOrder,
} from '@/lib/orderRelay';
import { isOrderTokenLike } from '@/lib/orderToken';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const USED_LOCK_MARKER = 'pending';

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableOrderRelay) return fail('not_found', 404);

  // handle は URL query (?h=) で受ける。MobileOrderView が webhook URL に固定し、
  // CheckoutForm は payload を POST するだけ (CheckoutForm 無改変)。
  const handle = normalizeHandle(new URL(req.url).searchParams.get('h') ?? '');
  if (!handle) return fail('handle_required', 400);

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

  // 冪等クレーム: **txHash のみ** (1 決済 1 注文)。重複 POST は no-op (再追加しない)。
  const usedKey = orderUsedKey(chainId, txHash);
  if (isKvConfigured()) {
    const claim = await kvSet(usedKey, USED_LOCK_MARKER, { nx: true, ttlSec: ORDER_USED_TTL_SEC });
    if (!claim.ok) return fail('kv_error', 503);
    if (claim.value === null) return NextResponse.json({ ok: true, duplicate: true });
  }

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

  const order: StoredOrder = {
    orderId,
    items: sanitizeOrderItems(o.items),
    table: sanitizeTable(o.description), // checkout description = テーブル番号ラベル (店内のみ)
    amount: result.value.toString(), // **実着金 (権威)** — recover は total−fee, free は total
    txHash,
    chainId,
    from: typeof o.from === 'string' && isAddress(o.from) ? getAddress(o.from) : '',
    ts: Date.now(),
    fulfilled: false,
  };
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

  if (isKvConfigured()) {
    const key = orderListKey(merchant);
    const push = await kvLpush(key, serializeOrder(order));
    if (!push.ok) {
      await kvDel(usedKey); // 保存できなければクレームも戻す (リトライで再投入可能に)
      return fail('kv_error', 503);
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

  logger.info('order.notify.stored', { chainId, merchant, amount: order.amount });
  return NextResponse.json({ ok: true, orderId });
}
