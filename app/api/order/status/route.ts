// 顧客向け「注文状況」read 専用エンドポイント (お渡し準備完了通知・flag NEXT_PUBLIC_ENABLE_ORDER_PICKUP)。
// 顧客端末が生成した不可推測の status トークン (?t=) で **自分の 1 注文の coarse な状態だけ** を返す:
//   token → order:sv:<token> = {merchant,chainId,txHash} を逆引き → 受取アドレスの受注リストから当該
//   txHash を探し orderPickupState を導出。
// 返却は最小 (state / orderId / pickupAt / readyAt / updatedAt のみ)。items / table / 金額 / 支払元は
// 返さない = トークンが万一漏れてもプライバシー被害を最小化する。書込・送金は一切しない (read only)。
// flag OFF=404・KV 未設定/障害=503・不正トークン=400・未知/失効/受注消滅=404。設計: plans/order-pickup-notify.md。
//
// rate-limit は付けない: トークンは 256-bit の秘密 (列挙不可) で、無効トークンは pointer kvGet が null →
// list 走査前に 404 で返す安価経路。正当トークンの顧客は 8s ポーリングで自分の 1 注文を読むだけ。
// 書込系 (notify/feed) と違い不要な防御で正当なポーリングを阻害しない方針。

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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const NO_STORE = { 'Cache-Control': 'no-store' };

function err(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableOrderPickup) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (!isKvConfigured()) return err('kv_unavailable', 503);

  const token = new URL(req.url).searchParams.get('t') ?? '';
  if (!isOrderTokenLike(token)) return err('invalid_token', 400);

  // token → 受注の所在。未知/失効 (72h TTL 切れ) は pointer が null。
  const ptr = await kvGet(orderStatusPointerKey(token));
  if (!ptr.ok) return err('kv_error', 503);
  if (ptr.value === null) return err('not_found', 404);

  const loc = parseOrderStatusPointer(ptr.value);
  if (!loc || !isAddress(loc.merchant)) return err('not_found', 404);
  const txLower = loc.txHash.toLowerCase();

  // 受取アドレスの受注リストから当該 txHash を探す。token はその注文固有の秘密ゆえ、顧客は
  // 自分の 1 注文の状態だけに到達する (他注文/他店舗は読めない)。
  const list = await kvLrange(orderListKey(loc.merchant), 0, ORDER_LIST_MAX - 1);
  if (!list.ok) return err('kv_error', 503);

  for (const raw of list.value ?? []) {
    const order = parseStoredOrder(raw);
    if (order && order.txHash.toLowerCase() === txLower) {
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
