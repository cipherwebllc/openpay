// 顧客のスタッフ呼び出し。決済済み受注 (orderId+txHash+table) に束縛し、既存の決済/notify 経路とは
// 完全に独立した新規 write 面として保存する。SIWE は不要だが、IP・注文・handle・table の多層制限を持つ。
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';
import { env } from '@/lib/env';
import { validateHandle } from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import { kvEval, kvLrange, isKvConfigured } from '@/lib/kv';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { randomId } from '@/lib/id';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import {
  callListKey,
  isTxHashLike,
  orderListKey,
  parseStoredOrder,
  sanitizeTable,
  ORDER_CALL_LIST_MAX,
  ORDER_CALL_LIST_TTL_SEC,
  ORDER_LIST_MAX,
  type StoredCall,
} from '@/lib/orderRelay';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { readShopLive } from '@/lib/shopLiveStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// body 上限 (逐次読みで打ち切る)。受理するのは {h, orderId, txHash, table} の 4 項目のみ。
const ORDER_CALL_BODY_MAX_BYTES = 4 * 1024;

const ORDER_WINDOW_MS = 2 * 60 * 60 * 1000;
const COOLDOWN_SEC = 30;
const ORDER_LIMIT = 5;
const HANDLE_LIMIT = 10;
const HANDLE_WINDOW_SEC = 5 * 60;

// 制限判定を先に完了し、許可時だけ cooldown/count/list をまとめて書く。閾値超過ではどのキーも変更しない。
const COMMIT_CALL = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return cjson.encode({ok=false, reason='cooldown'})
end
local orderCount = tonumber(redis.call('GET', KEYS[3]) or '0')
if orderCount >= tonumber(ARGV[2]) then
  return cjson.encode({ok=false, reason='order_limit'})
end
local handleCount = tonumber(redis.call('GET', KEYS[4]) or '0')
if handleCount >= tonumber(ARGV[3]) then
  return cjson.encode({ok=false, reason='velocity'})
end
local locked = redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[4])
if not locked then
  return cjson.encode({ok=false, reason='cooldown'})
end
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], ARGV[5])
redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], ARGV[6])
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, ARGV[7])
redis.call('EXPIRE', KEYS[1], ARGV[8])
return cjson.encode({ok=true})
`;

type CommitResult =
  | { ok: true }
  | { ok: false; reason: 'cooldown' | 'order_limit' | 'velocity' };

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

function commitResult(value: unknown): CommitResult | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.ok === true) return { ok: true };
    if (
      parsed.ok === false &&
      (parsed.reason === 'cooldown' ||
        parsed.reason === 'order_limit' ||
        parsed.reason === 'velocity')
    ) {
      return { ok: false, reason: parsed.reason };
    }
  } catch {
    // KV の契約外応答は成功扱いにせず、下で 503 にする。
  }
  return null;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableOrderCall) return fail('not_found', 404);
  if (!isKvConfigured()) return fail('kv_unavailable', 503);

  const capped = await readJsonBodyCapped(req, ORDER_CALL_BODY_MAX_BYTES);
  if (!capped.ok) {
    if (capped.reason === 'too_large') return fail('payload_too_large', 413);
    return fail('invalid_json', 400);
  }
  const body: unknown = capped.value;
  if (!body || typeof body !== 'object') return fail('invalid_body', 400);
  const o = body as Record<string, unknown>;
  if (
    typeof o.h !== 'string' ||
    typeof o.orderId !== 'string' ||
    o.orderId.length === 0 ||
    !isTxHashLike(o.txHash)
  ) {
    return fail('invalid_body', 400);
  }
  const validated = validateHandle(o.h);
  if (!validated.ok) return fail('invalid_handle', 400);
  const table = sanitizeTable(o.table);
  if (!table) return fail('invalid_table', 400);

  // IP_HASH_SECRET 未設定/短すぎでは hashIp=null となり IP limiter は仕様どおり素通りする。
  // その場合も下の決済済み注文束縛・per-order・per-handle・table cooldown が主防御として残る。
  const ipAllowed = await checkIpRateLimit(
    'order-call',
    hashIp(clientIp(req)),
    5,
    60,
  );
  if (!ipAllowed) return fail('rate_limited', 429);

  const resolved = await resolveHandle(validated.handle);
  if (!resolved.ok) return fail('kv_error', 503);
  if (!resolved.record) return fail('handle_not_found', 404);
  if (!resolved.record.storefront) return fail('storefront_not_found', 404);
  if (resolved.record.storefront.dineIn !== true) return fail('dine_in_required', 403);
  if (resolved.record.storefront.acceptingOrders === false) {
    return fail('orders_not_accepted', 409);
  }
  if (env.enableShopLive) {
    const live = await readShopLive(validated.handle); // 障害時 paused=false の fail-open は既存仕様。
    if (live.paused) return fail('orders_paused', 409);
  }

  let merchant: string;
  try {
    merchant = getAddress(resolved.record.config.to);
  } catch {
    return fail('storefront_not_found', 404);
  }
  const orders = await kvLrange(orderListKey(merchant), 0, ORDER_LIST_MAX - 1);
  if (!orders.ok) return fail('kv_error', 503);
  const now = Date.now();
  const txLower = o.txHash.toLowerCase();
  const matchingIdentity = (orders.value ?? [])
    .map(parseStoredOrder)
    .find(
      (order) =>
        order !== null &&
        order.orderId === o.orderId &&
        order.txHash.toLowerCase() === txLower &&
        order.ts <= now &&
        now - order.ts <= ORDER_WINDOW_MS,
    );
  if (!matchingIdentity) return fail('order_not_found', 404);
  // 現行 checkout description は locale により「テーブル N」/「Table N」で保存される。call payload は
  // 表示用の生テーブル番号 N を送るため、既存 2 prefix だけを明示的に同値扱いする。
  if (
    matchingIdentity.table !== table &&
    matchingIdentity.table !== `テーブル ${table}` &&
    matchingIdentity.table !== `Table ${table}`
  ) {
    return fail('table_mismatch', 403);
  }

  const entry: StoredCall = {
    id: randomId(),
    handle: validated.handle,
    table,
    ts: now,
  };
  const merchantScope = merchant.toLowerCase();
  const orderScope = `${encodeURIComponent(o.orderId)}:${txLower}`;
  const result = await kvEval<string>(
    COMMIT_CALL,
    [
      callListKey(merchant),
      `order:call:cooldown:${validated.handle}:${encodeURIComponent(table)}`,
      `order:call:count:order:${merchantScope}:${orderScope}`,
      `order:call:count:handle:${validated.handle}`,
    ],
    [
      JSON.stringify(entry),
      String(ORDER_LIMIT),
      String(HANDLE_LIMIT),
      String(COOLDOWN_SEC),
      String(ORDER_WINDOW_MS / 1000),
      String(HANDLE_WINDOW_SEC),
      String(ORDER_CALL_LIST_MAX - 1),
      String(ORDER_CALL_LIST_TTL_SEC),
    ],
  );
  if (!result.ok) return fail('kv_error', 503);
  const committed = commitResult(result.value);
  if (!committed) return fail('kv_error', 503);
  if (!committed.ok) return fail(committed.reason, 429);
  return NextResponse.json({ ok: true, call: entry });
}
