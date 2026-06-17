// 店主の受注フィード (SIWE 必須)。read authz は厳格に **session.address === 受取アドレス**
// (= 注文リストの KV キー)。店主は受取ウォレットでサインインして自分宛の受注のみ見られる
// (@handle owner 経由は owner≠config.to のなりすまし穴ゆえ不採用)。
// GET = 受注一覧 (新しい順)。POST = 該当 orderId を「対応済み」= リストから削除。
// flag OFF は 404。KV 障害は 503 で正直に返す (黙って空リストにしない)。設計: plans/swift-puzzling-sky.md。
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { kvLrange, kvLrem, kvLpush, isKvConfigured } from '@/lib/kv';
import {
  orderListKey,
  parseStoredOrder,
  serializeOrder,
  isTxHashLike,
  ORDER_LIST_MAX,
  type StoredOrder,
} from '@/lib/orderRelay';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}

export async function GET(): Promise<NextResponse> {
  if (!env.enableOrderRelay) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;

  if (!isKvConfigured()) {
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  const res = await kvLrange(orderListKey(session.address), 0, ORDER_LIST_MAX - 1);
  if (!res.ok) {
    // KV 障害を黙殺しない (空リストと区別 → UI は「一時的に取得不可」を出せる)。
    logger.warn('order.feed.kv_error', { reason: res.reason });
    return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 });
  }
  const orders: StoredOrder[] = (res.value ?? [])
    .map((raw) => parseStoredOrder(raw))
    .filter((o): o is StoredOrder => o !== null)
    .sort((a, b) => b.ts - a.ts);
  return NextResponse.json({ ok: true, orders });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableOrderRelay) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const o = (body ?? {}) as { txHash?: unknown; fulfilled?: unknown };
  // 対象は **txHash** で指定 (orderId は人間向け短縮番号で衝突しうるため・txHash は一意)。
  if (!isTxHashLike(o.txHash)) {
    return NextResponse.json({ ok: false, error: 'tx_required' }, { status: 400 });
  }
  // 既定は「対応済み」(true)。明示的に false で「未対応に戻す」(誤操作の復旧)。
  const fulfilled = o.fulfilled !== false;
  if (!isKvConfigured()) {
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }

  const key = orderListKey(session.address);
  const res = await kvLrange(key, 0, ORDER_LIST_MAX - 1);
  if (!res.ok) return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 });

  // 該当 txHash の生エントリを fulfilled フラグ付けで書き換え (削除でなくフラグ化 → 復旧可能)。
  // KV リストは ts でソートして返すので、LREM→LPUSH の並び替えは表示に影響しない。自分のリストのみ操作。
  let updated = 0;
  for (const raw of res.value ?? []) {
    const parsed = parseStoredOrder(raw);
    if (parsed && parsed.txHash.toLowerCase() === o.txHash.toLowerCase()) {
      if (parsed.fulfilled === fulfilled) continue; // 既に同状態なら no-op
      const del = await kvLrem(key, raw);
      if (del.ok && del.value > 0) {
        await kvLpush(key, serializeOrder({ ...parsed, fulfilled }));
        updated += 1;
      }
    }
  }
  return NextResponse.json({ ok: true, updated });
}
