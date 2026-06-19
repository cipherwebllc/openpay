// 店主の受注フィード。認可は2系統: (1) **SIWE セッション** (オーナー本人=受取アドレス) または
// (2) **受注閲覧トークン** (x-order-token・enableOrderToken 時)。どちらも `merchant`(受取アドレス)を
// 解決し、`order:list:<merchant>` のみを読む。トークンは資金鍵なしの店員端末向けで、**閲覧+進捗操作
// のみ** (送金・受取先変更は不可・このルート以外は受理しない) = 店員の売上スキミングを構造的に防ぐ。
// GET = 受注一覧 (新しい順)。POST = 該当 txHash の状態更新 (op: fulfill/itemCooked/itemServed/setTable)。
// 削除でなくフラグ化し誤操作を復旧可能に。旧 {fulfilled} (base relay) は enableOrderRelay のみ、構造化
// {op:...} は Phase 3 ゆえ enableOrderFulfillment も要求 (kitchen/hall ルートと同じ二重ゲート)。
// flag OFF は 404。KV 障害は 503 で正直に返す (黙って空リストにしない)。設計: plans/swift-puzzling-sky.md。
// 観測性: KV/競合の失敗 (503/409) は logger.warn → Sentry event 化 (**本番 Sentry DSN 設定時のみ
// アラート化**・未設定なら console のみ)。400 (invalid_json/invalid_op/invalid_token) は client error ゆえ
// 意図的に無ログ (scanner/abuse でのノイズを避ける)。
import { NextResponse } from 'next/server';
import { isAddress, getAddress, type Address } from 'viem';
import { env } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { kvLrange, kvEval, kvGet, isKvConfigured } from '@/lib/kv';
import {
  orderListKey,
  parseStoredOrder,
  serializeOrder,
  parseOrderFeedOp,
  applyOrderOp,
  ORDER_LIST_MAX,
  type StoredOrder,
} from '@/lib/orderRelay';
import { isOrderTokenLike, orderTokenKey, orderTokenRevKey } from '@/lib/orderToken';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}
function invalidToken() {
  return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 401 });
}
function kvError() {
  return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 });
}

type Actor = { merchant: Address } | { response: NextResponse };

// 認可解決。トークン経路は KV 参照するため **呼び出し前に isKvConfigured() 済み**であること。
// 優先順: 受注閲覧トークン (あれば) → SIWE セッション。トークンは「現行トークン一致」検証で
// rotate/revoke 済みの旧トークンを確実に失効させる (セキュリティの要)。
async function resolveMerchant(req: Request): Promise<Actor> {
  if (env.enableOrderToken) {
    const token = req.headers.get('x-order-token');
    if (token) {
      if (!isOrderTokenLike(token)) return { response: invalidToken() };
      const rev = await kvGet(orderTokenRevKey(token));
      if (!rev.ok) {
        logger.warn('order.feed.kv_error', { reason: rev.reason, op: 'token_lookup' });
        return { response: kvError() };
      }
      if (!rev.value || !isAddress(rev.value)) return { response: invalidToken() };
      const merchant = getAddress(rev.value);
      const cur = await kvGet(orderTokenKey(merchant));
      if (!cur.ok) {
        logger.warn('order.feed.kv_error', { reason: cur.reason, op: 'token_current' });
        return { response: kvError() };
      }
      if (cur.value !== token) return { response: invalidToken() }; // 失効済み (rotate/revoke)
      return { merchant };
    }
  }
  const session = await requireSession();
  if (!session.ok) return { response: session.response };
  return { merchant: session.address };
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableOrderRelay) return notFound();
  // KV 検査を認可より前に (トークン経路の resolveMerchant が KV を参照するため)。
  if (!isKvConfigured()) {
    logger.warn('order.feed.kv_unavailable', { op: 'get' }); // KV env 欠落デプロイを無音にしない
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  const actor = await resolveMerchant(req);
  if ('response' in actor) return actor.response;

  const res = await kvLrange(orderListKey(actor.merchant), 0, ORDER_LIST_MAX - 1);
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

// 対象要素を **位置維持 + キー TTL 保持** で原子置換する Lua: LPOS で旧 raw の index を引き、LSET で
// 同位置を新 raw に置換。LREM+LPUSH と違いリストを空にしないので、単一要素の更新でもキー (と 72h
// TTL) を消さない (= 受注の自然失効が壊れない)。旧 raw が同時更新で既に消えていれば LPOS が nil →
// return 0 → 呼出側が再読込してリトライ (CAS 相当・厨房 cooked × ホール served の同時更新も安全)。
const REPLACE_ELEM =
  "local idx=redis.call('LPOS',KEYS[1],ARGV[1]); " +
  'if not idx then return 0 end; ' +
  "redis.call('LSET',KEYS[1],idx,ARGV[2]); return 1";
const FEED_MAX_RETRY = 3;

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableOrderRelay) return notFound();
  // KV 検査を認可より前に (トークン経路の resolveMerchant が KV を参照するため)。
  if (!isKvConfigured()) {
    logger.warn('order.feed.kv_unavailable', { op: 'post' }); // KV env 欠落デプロイを無音にしない
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  const actor = await resolveMerchant(req);
  if ('response' in actor) return actor.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  // 構造化 {op:...} は Phase 3 (受注フルフィルメント) のオペレーション。enableOrderFulfillment が
  // OFF のときは受け付けない = kitchen/hall ルート (両フラグ必須) と同じ二重ゲートで完全 inert に。
  // 旧 {txHash, fulfilled} (base relay の OrderFeedPanel) は op を持たず enableOrderRelay のみで不変。
  if (
    !env.enableOrderFulfillment &&
    body !== null &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).op !== undefined
  ) {
    return notFound();
  }
  // 新 {txHash, op} と旧 {txHash, fulfilled} の両方を受理 (orderRelay.parseOrderFeedOp)。
  const parsedOp = parseOrderFeedOp(body);
  if (!parsedOp) {
    return NextResponse.json({ ok: false, error: 'invalid_op' }, { status: 400 });
  }

  const key = orderListKey(actor.merchant);
  const txLower = parsedOp.txHash.toLowerCase();

  // read→apply→CAS-replace を最大 FEED_MAX_RETRY 回 (同時更新で旧 raw が消えていれば再読込)。
  for (let attempt = 0; attempt < FEED_MAX_RETRY; attempt++) {
    const res = await kvLrange(key, 0, ORDER_LIST_MAX - 1);
    if (!res.ok) {
      logger.warn('order.feed.kv_error', { reason: res.reason, op: 'post_read' });
      return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 });
    }

    let oldRaw: string | null = null;
    let order: StoredOrder | null = null;
    for (const raw of res.value ?? []) {
      const p = parseStoredOrder(raw);
      if (p && p.txHash.toLowerCase() === txLower) {
        oldRaw = raw;
        order = p;
        break;
      }
    }
    if (!oldRaw || !order) return NextResponse.json({ ok: true, updated: 0 }); // 対象なし

    const newRaw = serializeOrder(applyOrderOp(order, parsedOp.op));
    if (newRaw === oldRaw) return NextResponse.json({ ok: true, updated: 0 }); // 変化なし (no-op)

    const cas = await kvEval<number>(REPLACE_ELEM, [key], [oldRaw, newRaw]);
    if (!cas.ok) {
      logger.warn('order.feed.kv_error', { reason: cas.reason, op: 'cas' });
      return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 });
    }
    if (cas.value === 1) return NextResponse.json({ ok: true, updated: 1 });
    // cas.value === 0: 旧 raw が同時更新で消えた → 再読込してリトライ。
  }
  // FEED_MAX_RETRY 回連続で CAS 競合 = 高頻度の同時更新 (contention)。監視/アラート用に記録。
  logger.warn('order.feed.conflict', { attempts: FEED_MAX_RETRY });
  return NextResponse.json({ ok: false, error: 'conflict' }, { status: 409 });
}
