// 店側のスタッフ呼び出し一覧。認可主体は /api/order/feed と同じ共有 helper で解決する。
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { isKvConfigured, kvEval, kvLrange } from '@/lib/kv';
import { logger } from '@/lib/logger';
import {
  callListKey,
  parseStoredCall,
  ORDER_CALL_LIST_MAX,
  ORDER_CALL_VISIBLE_MS,
  type StoredCall,
} from '@/lib/orderRelay';
import { resolveOrderFeedMerchant } from '@/lib/orderFeedAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const REMOVE_CALL = `
local rows = redis.call('LRANGE', KEYS[1], 0, -1)
local removed = 0
for _, raw in ipairs(rows) do
  local ok, value = pcall(cjson.decode, raw)
  if ok and type(value) == 'table' and value.id == ARGV[1] then
    removed = removed + redis.call('LREM', KEYS[1], 0, raw)
  end
end
return removed
`;

function fail(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

async function actorFor(req: Request, op: 'get' | 'post') {
  if (!isKvConfigured()) {
    logger.warn('order.calls.kv_unavailable', { op });
    return { response: fail('kv_unavailable', 503) } as const;
  }
  return resolveOrderFeedMerchant(req);
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableOrderCall) return fail('not_found', 404);
  const actor = await actorFor(req, 'get');
  if ('response' in actor) return actor.response;
  const result = await kvLrange(callListKey(actor.merchant), 0, ORDER_CALL_LIST_MAX - 1);
  if (!result.ok) return fail('kv_error', 503);
  const cutoff = Date.now() - ORDER_CALL_VISIBLE_MS;
  const calls: StoredCall[] = (result.value ?? [])
    .map(parseStoredCall)
    .filter((call): call is StoredCall => call !== null && call.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts);
  return NextResponse.json({ ok: true, calls });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!env.enableOrderCall) return fail('not_found', 404);
  const actor = await actorFor(req, 'post');
  if ('response' in actor) return actor.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_json', 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as Record<string, unknown>).id !== 'string' ||
    (body as Record<string, unknown>).done !== true
  ) {
    return fail('invalid_body', 400);
  }
  const id = (body as { id: string }).id;
  if (id.length === 0 || id.length > 128) return fail('invalid_body', 400);
  const result = await kvEval<number>(REMOVE_CALL, [callListKey(actor.merchant)], [id]);
  if (!result.ok) return fail('kv_error', 503);
  return NextResponse.json({ ok: true, removed: result.value ?? 0 });
}
