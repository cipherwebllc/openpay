// 顧客向け「注文状況」read 専用エンドポイント (お渡し準備完了通知・flag NEXT_PUBLIC_ENABLE_ORDER_PICKUP)。
// 顧客端末が生成した不可推測の status トークン (?t=) で **自分の 1 注文の coarse な状態だけ** を返す:
//   token → order:sv:<token> = {merchant,chainId,txHash} を逆引き → 受取アドレスの受注リストから当該
//   txHash を探し orderPickupState を導出。
// 返却は最小 (state / orderId / pickupAt / readyAt / updatedAt のみ)。items / table / 金額 / 支払元は
// 返さない = トークンが万一漏れてもプライバシー被害を最小化する。書込・送金は一切しない (read only)。
// flag OFF=404・KV 未設定/障害=503・不正トークン=400・未知/失効/受注消滅=404。設計: plans/order-pickup-notify.md。
//
// rate-limit: IP 単位の固定窓 (120/分・checkReadRateLimit) を pointer 参照の前に置く。秘密トークン
// ゆえ列挙はできないが、公開・無認証の read ゆえ単一 IP の volumetric flood による KV read 圧力を
// 上限で抑える。8s ポーリング (≒8/分・複数タブ/復帰再取得を含めても上限の遥か下) は阻害しない。

import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { env } from '@/lib/env';
import { kvGet, kvLrange, isKvConfigured } from '@/lib/kv';
import {
  orderStatusPointerKey,
  orderListKey,
  parseStoredOrder,
  parseOrderStatusPointer,
  orderPickupState,
  ORDER_LIST_MAX,
} from '@/lib/orderRelay';
import { isOrderTokenLike } from '@/lib/orderToken';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const NO_STORE = { 'Cache-Control': 'no-store' };

function err(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableOrderPickup) return err('not_found', 404); // err は no-store 付き (CDN に stale 404 を残さない)
  if (!isKvConfigured()) {
    logger.warn('order.status.kv_unavailable'); // KV env 欠落デプロイを無音にしない
    return err('kv_unavailable', 503);
  }

  const token = new URL(req.url).searchParams.get('t') ?? '';
  if (!isOrderTokenLike(token)) return err('invalid_token', 400);

  // IP 固定窓 (公開・無認証 read の volumetric flood 抑制)。正当な 8s ポーリングの遥か上の寛容な上限。
  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );
  if (!(await checkReadRateLimit(`orderstatus:${ipPrefix}`, 120, 60))) {
    return err('rate_limited', 429);
  }

  // token → 受注の所在。未知/失効 (72h TTL 切れ) は pointer が null。
  const ptr = await kvGet(orderStatusPointerKey(token));
  if (!ptr.ok) {
    logger.warn('order.status.kv_error', { reason: ptr.reason, op: 'pointer' });
    return err('kv_error', 503);
  }
  if (ptr.value === null) return err('not_found', 404);

  const loc = parseOrderStatusPointer(ptr.value);
  if (!loc || !isAddress(loc.merchant)) return err('not_found', 404);
  const txLower = loc.txHash.toLowerCase();

  // 受取アドレスの受注リストから当該 txHash を探す。token はその注文固有の秘密ゆえ、顧客は
  // 自分の 1 注文の状態だけに到達する (他注文/他店舗は読めない)。
  const list = await kvLrange(orderListKey(loc.merchant), 0, ORDER_LIST_MAX - 1);
  if (!list.ok) {
    logger.warn('order.status.kv_error', { reason: list.reason, op: 'list' });
    return err('kv_error', 503);
  }

  for (const raw of list.value ?? []) {
    const order = parseStoredOrder(raw);
    // txHash + chainId 両方一致 (冪等は chainId+txHash モデル・pointer の chainId も照合し KV 不整合に堅牢)。
    if (order && order.txHash.toLowerCase() === txLower && order.chainId === loc.chainId) {
      return NextResponse.json(
        {
          ok: true,
          state: orderPickupState(order),
          orderId: order.orderId,
          ...(order.pickupAt !== undefined ? { pickupAt: order.pickupAt } : {}),
          ...(order.readyAt !== undefined ? { readyAt: order.readyAt } : {}),
          updatedAt: order.ts,
        },
        { headers: NO_STORE },
      );
    }
  }
  // pointer はあるが受注が見つからない (リスト上限で押し出し / TTL 失効)。
  return err('not_found', 404);
}
