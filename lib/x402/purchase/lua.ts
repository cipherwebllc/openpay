// creator-store hosted purchase の Upstash EVAL 用 Lua (13 本)。
// 本文は byte 単位で固定 (tests/lib/license/digitalCompatibility.test.ts の SHA-256)。
// KEYS / ARGV の順序は呼び出し側 (lib/x402/purchaseIntent.ts) が決め、
// tests/lib/x402/purchaseIntentCompatibility.test.ts が呼び出しごとに固定する。
// 外部送信する Lua なので ${} 補間や + 連結を持ち込まない (scripts/check-lua-bundle.mjs の教訓)。

import 'server-only';

export const QUOTE_RATE_LIMIT = `
local allowed = tonumber(ARGV[1])
local denied = tonumber(ARGV[2])
local first = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local invalid = tonumber(ARGV[#KEYS + 8])
local function keyType(key)
  local result = redis.call('TYPE', key)
  if type(result) == ARGV[#KEYS + 7] then
    return result.ok
  end
  return result
end
if not allowed or not denied or not first or not window then
  return invalid
end
for index, key in ipairs(KEYS) do
  local currentType = keyType(key)
  if (currentType ~= ARGV[#KEYS + 5] and
      currentType ~= ARGV[#KEYS + 6]) or
      not tonumber(ARGV[index + 4]) then
    return invalid
  end
end
local function increment(index)
  local key = KEYS[index]
  local count = redis.call('INCR', key)
  local ttl = redis.call('TTL', key)
  if count == first or ttl < tonumber(ARGV[2]) then
    redis.call('EXPIRE', key, ARGV[4])
  end
  return count <= tonumber(ARGV[index + 4])
end
-- Denied IP traffic must not exhaust other buyers' resource or wallet buckets.
-- KEYS[3] is optional; wallet/resource remain KEYS[1]/KEYS[2].
if #KEYS == 3 and not increment(3) then
  return denied
end
for index = 1, 2 do
  if not increment(index) then
    allowed = denied
  end
end
return allowed
`;

export const CLAIM_SIGNED_INTENT = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[20] and pendingType ~= ARGV[21]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local current = redis.call('GET', KEYS[1])
if not current then
  return tonumber(ARGV[1])
end
local decodedOk, decoded = pcall(cjson.decode, current)
if not decodedOk or type(decoded) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if decoded.state == ARGV[4] then
  if decoded.bindingHash ~= ARGV[5] then
    return tonumber(ARGV[6])
  end
  if tonumber(ARGV[7]) >= tonumber(decoded.quoteExpiresAt) then
    return tonumber(ARGV[8])
  end
  redis.call('SET', KEYS[1], ARGV[9])
  redis.call('PERSIST', KEYS[1])
  redis.call('ZADD', KEYS[2], ARGV[10], ARGV[11])
  return tonumber(ARGV[12])
end
if decoded.state == ARGV[13] or decoded.state == ARGV[14] or
    decoded.state == ARGV[15] or decoded.state == ARGV[16] then
  if decoded.authorizationHash == ARGV[17] and
      decoded.claim.signatureFingerprint == ARGV[18] then
    return tonumber(ARGV[19])
  end
end
return tonumber(ARGV[6])
`;

export const CLAIM_SETTLEMENT = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[20] and pendingType ~= ARGV[21]) or
    not tonumber(ARGV[12]) then
  return tonumber(ARGV[3])
end
local current = redis.call('GET', KEYS[1])
if not current then
  return tonumber(ARGV[1])
end
local decodedOk, decoded = pcall(cjson.decode, current)
if not decodedOk or type(decoded) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if decoded.authorizationHash ~= ARGV[4] or
    decoded.claim.signatureFingerprint ~= ARGV[5] then
  return tonumber(ARGV[6])
end
if decoded.state == ARGV[7] then
  if tonumber(ARGV[8]) + tonumber(ARGV[9]) >=
      tonumber(decoded.claim.validBefore) then
    return tonumber(ARGV[10])
  end
  redis.call('SET', KEYS[1], ARGV[11])
  redis.call('ZADD', KEYS[2], ARGV[12], ARGV[13])
  return tonumber(ARGV[14])
end
if decoded.state == ARGV[15] or decoded.state == ARGV[16] then
  return tonumber(ARGV[17])
end
if decoded.state == ARGV[18] then
  return tonumber(ARGV[19])
end
return tonumber(ARGV[6])
`;

export const CAS_PENDING_INTENT = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[12] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[10] and pendingType ~= ARGV[11]) or
    (ARGV[5] ~= ARGV[6] and not tonumber(ARGV[8])) then
  return tonumber(ARGV[13])
end
local current = redis.call('GET', KEYS[1])
if not current then
  return tonumber(ARGV[1])
end
if current ~= ARGV[2] then
  return tonumber(ARGV[3])
end
redis.call('SET', KEYS[1], ARGV[4])
if ARGV[5] == ARGV[6] then
  redis.call('ZREM', KEYS[2], ARGV[7])
else
  redis.call('ZADD', KEYS[2], ARGV[8], ARGV[7])
end
return tonumber(ARGV[9])
`;

export const RECORD_PURCHASE_TRANSACTION = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[14] and pendingType ~= ARGV[15]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[8] then
  if current.txHash == ARGV[5] then
    return tonumber(ARGV[13])
  end
  return tonumber(ARGV[9])
end
if (current.state ~= ARGV[6] and current.state ~= ARGV[7]) or
    current.attemptId ~= ARGV[4] or
    (current.txHash and current.txHash ~= ARGV[5]) then
  return tonumber(ARGV[9])
end
current.txHash = ARGV[5]
current.nextReconcileAt = tonumber(ARGV[10])
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZADD', KEYS[2], ARGV[10], ARGV[11])
return tonumber(ARGV[12])
`;

export const ADOPT_RECONCILED_TRANSACTION = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[13] and pendingType ~= ARGV[14]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if (current.state ~= ARGV[4] and current.state ~= ARGV[5]) or
    current.reconcileLeaseId ~= ARGV[6] or
    current.authorizationHash ~= ARGV[7] then
  return tonumber(ARGV[8])
end
current.txHash = ARGV[9]
current.nextReconcileAt = tonumber(ARGV[10])
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZADD', KEYS[2], ARGV[10], ARGV[11])
return tonumber(ARGV[12])
`;

// settle response と status/cron lease が競合しても、txHash を古い raw CAS で落とさず
// 最新 intent に merge する。response-unknown が二重送金や回復不能へ波及するのを断つ。
export const MARK_PURCHASE_INDETERMINATE = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[16] and pendingType ~= ARGV[17]) or
    not tonumber(ARGV[12]) or not tonumber(ARGV[13]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[4] then
  if ARGV[10] ~= ARGV[11] and current.txHash ~= ARGV[10] then
    return tonumber(ARGV[9])
  end
  return tonumber(ARGV[5])
end
if (current.state ~= ARGV[6] and current.state ~= ARGV[7]) or
    current.attemptId ~= ARGV[8] or
    (current.txHash and ARGV[10] ~= ARGV[11] and
     current.txHash ~= ARGV[10]) then
  return tonumber(ARGV[9])
end
if ARGV[10] ~= ARGV[11] then
  current.txHash = ARGV[10]
end
if current.state == ARGV[6] then
  current.state = ARGV[7]
  current.indeterminateAt = tonumber(ARGV[12])
end
current.nextReconcileAt = tonumber(ARGV[13])
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZADD', KEYS[2], ARGV[13], ARGV[14])
return tonumber(ARGV[15])
`;

export const MARK_PURCHASE_FAILED_PREBROADCAST = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[2] then
  pendingType = pendingType.ok
end
if (pendingType ~= ARGV[14] and pendingType ~= ARGV[15]) or
    not tonumber(ARGV[10]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[4] then
  return tonumber(ARGV[5])
end
if (current.state ~= ARGV[6] and current.state ~= ARGV[7]) or
    current.attemptId ~= ARGV[8] or current.txHash then
  return tonumber(ARGV[9])
end
current.state = ARGV[4]
current.failedAt = tonumber(ARGV[10])
current.failureReason = ARGV[11]
local nextRaw = cjson.encode(current)
redis.call('SET', KEYS[1], nextRaw)
redis.call('ZREM', KEYS[2], ARGV[12])
return tonumber(ARGV[13])
`;

export const FINALIZE_PURCHASE = `
local function keyType(key)
  local result = redis.call('TYPE', key)
  if type(result) == ARGV[2] then
    return result.ok
  end
  return result
end
local libraryType = keyType(KEYS[3])
local pendingType = keyType(KEYS[5])
if (libraryType ~= ARGV[28] and libraryType ~= ARGV[29]) or
    (pendingType ~= ARGV[28] and pendingType ~= ARGV[29]) or
    not tonumber(ARGV[19]) or not tonumber(ARGV[20]) or
    not tonumber(ARGV[21]) then
  return tonumber(ARGV[3])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  return tonumber(ARGV[1])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
if current.state == ARGV[4] then
  if current.txHash ~= ARGV[5] or
      current.authorizationHash ~= ARGV[6] then
    return tonumber(ARGV[7])
  end
  local ownRaw = redis.call('GET', KEYS[2])
  local purchaseRaw = redis.call('GET', KEYS[4])
  if not ownRaw or not purchaseRaw or ownRaw ~= ARGV[25] or
      purchaseRaw ~= ARGV[26] then
    return tonumber(ARGV[3])
  end
  redis.call('ZADD', KEYS[3], ARGV[20], ARGV[18])
  redis.call('ZREM', KEYS[5], ARGV[12])
  return tonumber(ARGV[8])
end
if currentRaw ~= ARGV[9] then
  return tonumber(ARGV[7])
end
if current.state ~= ARGV[10] and current.state ~= ARGV[11] then
  return tonumber(ARGV[7])
end
if current.authorizationHash ~= ARGV[6] then
  return tonumber(ARGV[7])
end
if current.txHash and current.txHash ~= ARGV[5] then
  return tonumber(ARGV[7])
end

local purchaseRaw = redis.call('GET', KEYS[4])
local ownRaw = redis.call('GET', KEYS[2])
if (purchaseRaw or ARGV[27]) ~= ARGV[26] or
    (ownRaw or ARGV[27]) ~= ARGV[25] then
  return tonumber(ARGV[7])
end
if purchaseRaw then
  local purchaseOk, purchase = pcall(cjson.decode, purchaseRaw)
  if not purchaseOk or type(purchase) ~= ARGV[2] or
      purchase.intentSalt ~= ARGV[12] or purchase.txHash ~= ARGV[5] or
      purchase.nonce ~= current.claim.nonce then
    return tonumber(ARGV[7])
  end
end

local grantOk, grant = pcall(cjson.decode, ARGV[13])
local initialOwnOk, initialOwn = pcall(cjson.decode, ARGV[14])
if not grantOk or not initialOwnOk or type(grant) ~= ARGV[2] or
    type(initialOwn) ~= ARGV[2] then
  return tonumber(ARGV[3])
end
local nextOwn = initialOwn
if ownRaw then
  local ownOk, own = pcall(cjson.decode, ownRaw)
  if not ownOk or type(own) ~= ARGV[2] or own.version ~= tonumber(ARGV[15]) or
      own.policy ~= ARGV[16] or own.payer ~= ARGV[17] or
      own.resourceId ~= ARGV[18] or type(own.grants) ~= ARGV[2] then
    return tonumber(ARGV[3])
  end
  local found = false
  for _, existing in ipairs(own.grants) do
    if existing.intentSalt == ARGV[12] then
      if existing.txHash ~= ARGV[5] or
          existing.contentRevision ~= grant.contentRevision then
        return tonumber(ARGV[7])
      end
      found = true
    end
  end
  if not found then
    table.insert(own.grants, grant)
  end
  if tonumber(ARGV[19]) < tonumber(own.firstPurchasedAt) then
    own.firstPurchasedAt = tonumber(ARGV[19])
  end
  if not own.latestGrant or
      tonumber(grant.contentRevision) > tonumber(own.latestGrant.contentRevision) or
      (tonumber(grant.contentRevision) == tonumber(own.latestGrant.contentRevision) and
       tonumber(grant.purchasedAt) > tonumber(own.latestGrant.purchasedAt)) then
    -- grants[] に入れた grant と同じ Lua テーブルを latestGrant にも参照させると、Upstash の
    -- cjson.encode は「同一テーブルの二重参照」を循環と誤検知して nil+error を返し (例外にならない)、
    -- 直後の SET が壊れて finalize が永久に失敗する (2026-09-08 Amoy 実測・同一商品の 2 回目購入)。
    -- 本家 Redis / WASM ハーネスでは再現しない。JSON から decode し直した別テーブルを持たせる。
    own.latestGrant = cjson.decode(ARGV[13])
  end
  if tonumber(ARGV[19]) > tonumber(own.updatedAt) then
    own.updatedAt = tonumber(ARGV[19])
  end
  nextOwn = own
end

redis.call('SET', KEYS[2], cjson.encode(nextOwn))
redis.call('ZADD', KEYS[3], ARGV[20], ARGV[18])
if not purchaseRaw then
  redis.call('SET', KEYS[4], ARGV[22])
end
redis.call('SET', KEYS[1], ARGV[23])
redis.call('ZREM', KEYS[5], ARGV[12])
return tonumber(ARGV[24])
`;

export const READ_LIBRARY_SCORE = `
return redis.call('ZSCORE', KEYS[1], ARGV[1])
`;

export const LIST_PENDING_INTENTS = `
return redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2],
  ARGV[3], ARGV[4], ARGV[5])
`;

export const REMOVE_TERMINAL_PENDING_MEMBER = `
local pendingType = redis.call('TYPE', KEYS[2])
if type(pendingType) == ARGV[1] then
  pendingType = pendingType.ok
end
if pendingType ~= ARGV[2] and pendingType ~= ARGV[3] then
  return tonumber(ARGV[4])
end
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  redis.call('ZREM', KEYS[2], ARGV[5])
  return tonumber(ARGV[6])
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= ARGV[1] then
  return tonumber(ARGV[7])
end
if current.state == ARGV[8] or current.state == ARGV[9] or
    current.state == ARGV[10] then
  redis.call('ZREM', KEYS[2], ARGV[5])
  return tonumber(ARGV[6])
end
return tonumber(ARGV[11])
`;

export const QUARANTINE_PENDING_MEMBER = `
local function keyType(key)
  local result = redis.call('TYPE', key)
  if type(result) == ARGV[1] then
    return result.ok
  end
  return result
end
local pendingType = keyType(KEYS[1])
local quarantineType = keyType(KEYS[2])
if (pendingType ~= ARGV[2] and pendingType ~= ARGV[3]) or
    (quarantineType ~= ARGV[2] and quarantineType ~= ARGV[3]) or
    not tonumber(ARGV[4]) then
  return tonumber(ARGV[5])
end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[6])
redis.call('ZREM', KEYS[1], ARGV[6])
return tonumber(ARGV[7])
`;
