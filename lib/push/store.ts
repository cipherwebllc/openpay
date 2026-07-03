import 'server-only';

import { createHash } from 'node:crypto';
import type { Address } from 'viem';
import { kvEval, kvExpire, kvGet } from '@/lib/kv';
import { env } from '@/lib/env';

export type PushLocale = 'ja' | 'en';

export type StoredPushSubscription = {
  endpointHash: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  locale: PushLocale;
  vapidKeyId: string;
  createdAt: number;
};

export type PushSubscriptionInput = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  locale: PushLocale;
  nowMs?: number;
};

type StoreOk<T> = { ok: true; value: T };
type StoreErr = { ok: false; reason: 'kv_error' | 'parse_error' };
export type StoreResult<T> = StoreOk<T> | StoreErr;

export const PUSH_SUBSCRIPTION_CAP = 5;
export const PUSH_SUBSCRIPTION_TTL_SEC = 90 * 24 * 60 * 60;

const UPSERT_SCRIPT = `
local key = KEYS[1]
local endpointHash = ARGV[1]
local endpoint = ARGV[2]
local p256dh = ARGV[3]
local auth = ARGV[4]
local locale = ARGV[5]
local vapidKeyId = ARGV[6]
local createdAt = tonumber(ARGV[7])
local ttl = tonumber(ARGV[8])
local cap = tonumber(ARGV[9])

local raw = redis.call('GET', key)
local list = {}
if raw and raw ~= '' then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then
    for _, item in ipairs(decoded) do
      if type(item) == 'table' and type(item.endpointHash) == 'string' then
        table.insert(list, item)
      end
    end
  end
end

local next = {
  endpointHash = endpointHash,
  endpoint = endpoint,
  keys = { p256dh = p256dh, auth = auth },
  locale = locale,
  vapidKeyId = vapidKeyId,
  createdAt = createdAt
}

local replaced = false
for i, item in ipairs(list) do
  if item.endpointHash == endpointHash then
    list[i] = next
    replaced = true
    break
  end
end
if not replaced then
  table.insert(list, next)
end

table.sort(list, function(a, b)
  return tonumber(a.createdAt or 0) < tonumber(b.createdAt or 0)
end)
while #list > cap do
  table.remove(list, 1)
end

local encoded = cjson.encode(list)
redis.call('SET', key, encoded, 'EX', ttl)
return encoded
`;

const REMOVE_SCRIPT = `
local key = KEYS[1]
local endpointHash = ARGV[1]
local ttl = tonumber(ARGV[2])

local raw = redis.call('GET', key)
local list = {}
if raw and raw ~= '' then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then
    for _, item in ipairs(decoded) do
      if type(item) == 'table' and item.endpointHash ~= endpointHash then
        table.insert(list, item)
      end
    end
  end
end

if #list == 0 then
  redis.call('DEL', key)
  return '[]'
end

local encoded = cjson.encode(list)
redis.call('SET', key, encoded, 'EX', ttl)
return encoded
`;

export function pushSubscriptionKey(wallet: Address | string): string {
  return `push:subs:${wallet.toLowerCase()}`;
}

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export function pushVapidKeyId(
  publicKey = env.pushVapidPublicKey,
): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 8);
}

export async function listPushSubscriptions(
  wallet: Address | string,
): Promise<StoreResult<StoredPushSubscription[]>> {
  const res = await kvGet(pushSubscriptionKey(wallet));
  if (!res.ok) return { ok: false, reason: 'kv_error' };
  if (res.value === null) return { ok: true, value: [] };
  const parsed = parseSubscriptionList(res.value);
  if (!parsed) return { ok: false, reason: 'parse_error' };
  return { ok: true, value: parsed };
}

export async function upsertPushSubscription(
  wallet: Address | string,
  input: PushSubscriptionInput,
): Promise<StoreResult<StoredPushSubscription[]>> {
  const record: StoredPushSubscription = {
    endpointHash: endpointHash(input.endpoint),
    endpoint: input.endpoint,
    keys: input.keys,
    locale: input.locale,
    vapidKeyId: pushVapidKeyId(),
    createdAt: input.nowMs ?? Date.now(),
  };
  const res = await kvEval<string>(
    UPSERT_SCRIPT,
    [pushSubscriptionKey(wallet)],
    [
      record.endpointHash,
      record.endpoint,
      record.keys.p256dh,
      record.keys.auth,
      record.locale,
      record.vapidKeyId,
      String(record.createdAt),
      String(PUSH_SUBSCRIPTION_TTL_SEC),
      String(PUSH_SUBSCRIPTION_CAP),
    ],
  );
  if (!res.ok) return { ok: false, reason: 'kv_error' };
  const parsed = parseSubscriptionList(res.value);
  if (!parsed) return { ok: false, reason: 'parse_error' };
  return { ok: true, value: parsed };
}

export async function removePushSubscription(
  wallet: Address | string,
  target: { endpoint: string } | { endpointHash: string },
): Promise<StoreResult<StoredPushSubscription[]>> {
  const hash = 'endpointHash' in target ? target.endpointHash : endpointHash(target.endpoint);
  const res = await kvEval<string>(
    REMOVE_SCRIPT,
    [pushSubscriptionKey(wallet)],
    [hash, String(PUSH_SUBSCRIPTION_TTL_SEC)],
  );
  if (!res.ok) return { ok: false, reason: 'kv_error' };
  const parsed = parseSubscriptionList(res.value);
  if (!parsed) return { ok: false, reason: 'parse_error' };
  return { ok: true, value: parsed };
}

export async function refreshPushSubscriptionsTtl(
  wallet: Address | string,
): Promise<boolean> {
  const res = await kvExpire(pushSubscriptionKey(wallet), PUSH_SUBSCRIPTION_TTL_SEC);
  return res.ok && res.value === 1;
}

function parseSubscriptionList(raw: string): StoredPushSubscription[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const list: StoredPushSubscription[] = [];
  for (const item of parsed) {
    if (!isStoredPushSubscription(item)) return null;
    list.push(item);
  }
  return list;
}

function isStoredPushSubscription(v: unknown): v is StoredPushSubscription {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.endpointHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.endpointHash))
    return false;
  if (typeof r.endpoint !== 'string') return false;
  if (r.locale !== 'ja' && r.locale !== 'en') return false;
  if (typeof r.vapidKeyId !== 'string' || !/^[0-9a-f]{8}$/.test(r.vapidKeyId))
    return false;
  if (
    typeof r.createdAt !== 'number' ||
    !Number.isFinite(r.createdAt) ||
    r.createdAt < 0
  )
    return false;
  if (!r.keys || typeof r.keys !== 'object' || Array.isArray(r.keys)) return false;
  const keys = r.keys as Record<string, unknown>;
  return typeof keys.p256dh === 'string' && typeof keys.auth === 'string';
}
