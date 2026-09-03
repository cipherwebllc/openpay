import 'server-only';

import { randomBytes } from 'node:crypto';
import { isAddress, type Address, type Hex } from 'viem';
import { kvEval } from '@/lib/kv';

export type StorePaymentRail = 'jpyc' | 'usdc';

const RAIL_PARENT_VERSION = 1;
const RAIL_PARENT_TTL_SEC = 7 * 24 * 60 * 60;

// rail を確定した (selected) 後の active slot / intent→parent 対応の保持期間 (B15)。
// 以前は PERSIST で無期限にしていたが、settling/indeterminate のまま終端に到達しない intent が
// 出ると同じ payer×resource×revision の slot が **恒久的に**塞がり (releaseActiveStoreRail は
// terminal しか解放しない)、KV も単調増加する。30 日は settle → reconciler → 手動調査まで
// 含めたどの正規フローよりも遥かに長く、生存中の排他 (JPYC/USDC 二重 broadcast 防止) には
// 一切影響しない。archive (KEYS[2]) は監査用に従来どおり無期限で残す。
const RAIL_SELECTED_TTL_SEC = 30 * 24 * 60 * 60;
const HASH_RE = /^(?:0x)?[0-9a-f]{64}$/;

type RailParent = {
  version: typeof RAIL_PARENT_VERSION;
  parentIntentId: string;
  payer: Address;
  resourceId: string;
  contentRevision: number;
  createdAt: number;
  selectedRail?: StorePaymentRail;
  selectedIntentSalt?: Hex;
  selectedIntentKey?: string;
  authorizationHash?: string;
};

function activeRailParentKey(
  payer: string,
  resourceId: string,
  contentRevision: number,
): string {
  return `store:rail:active:${payer.toLowerCase()}:${resourceId}:${contentRevision}`;
}

export function railIntentParentKey(intentSalt: string): string {
  return `store:rail:intent:${intentSalt.toLowerCase()}`;
}

export function railParentArchiveKey(parentIntentId: string): string {
  return `store:rail:parent:${parentIntentId}`;
}

function newParentIntentId(): string {
  return randomBytes(32).toString('hex');
}

const ASSOCIATE_RAIL_INTENT = `
local currentRaw = redis.call('GET', KEYS[1])
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if not ok or type(current) ~= ARGV[1] or current.version ~= tonumber(ARGV[2]) or
      current.payer ~= ARGV[3] or current.resourceId ~= ARGV[4] or
      tonumber(current.contentRevision) ~= tonumber(ARGV[5]) then
    return {ARGV[6]}
  end
  local terminal = false
  if current.selectedIntentKey then
    local selectedRaw = redis.call('GET', current.selectedIntentKey)
    if selectedRaw then
      local selectedOk, selected = pcall(cjson.decode, selectedRaw)
      terminal = selectedOk and type(selected) == ARGV[1] and
        (selected.state == ARGV[7] or selected.state == ARGV[8])
    end
  end
  if not terminal then
    redis.call('SET', KEYS[2], current.parentIntentId, 'EX', ARGV[9])
    return {current.parentIntentId}
  end
end
redis.call('SET', KEYS[1], ARGV[10], 'EX', ARGV[9])
redis.call('SET', KEYS[2], ARGV[11], 'EX', ARGV[9])
return {ARGV[11]}
`;

export async function associateStoreRailIntent(input: {
  intentSalt: Hex;
  intentKey: string;
  payer: Address;
  resourceId: string;
  contentRevision: number;
  now?: number;
}): Promise<
  | { ok: true; parentIntentId: string }
  | { ok: false; reason: 'invalid' | 'storage' | 'corrupt' }
> {
  if (
    !/^0x[0-9a-f]{64}$/.test(input.intentSalt) ||
    !isAddress(input.payer) ||
    !input.resourceId ||
    !Number.isSafeInteger(input.contentRevision) ||
    input.contentRevision < 1 ||
    !input.intentKey
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: 'invalid' };
  }
  const parentIntentId = newParentIntentId();
  const candidate: RailParent = {
    version: RAIL_PARENT_VERSION,
    parentIntentId,
    payer: input.payer,
    resourceId: input.resourceId,
    contentRevision: input.contentRevision,
    createdAt: now,
  };
  const result = await kvEval<string[]>(
    ASSOCIATE_RAIL_INTENT,
    [
      activeRailParentKey(
        input.payer,
        input.resourceId,
        input.contentRevision,
      ),
      railIntentParentKey(input.intentSalt),
    ],
    [
      'table',
      String(RAIL_PARENT_VERSION),
      input.payer,
      input.resourceId,
      String(input.contentRevision),
      '__corrupt__',
      'settled',
      'failed_prebroadcast',
      String(RAIL_PARENT_TTL_SEC),
      JSON.stringify(candidate),
      parentIntentId,
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
  const value = Array.isArray(result.value) ? result.value[0] : undefined;
  if (value === '__corrupt__') return { ok: false, reason: 'corrupt' };
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
    ? { ok: true, parentIntentId: value }
    : { ok: false, reason: 'corrupt' };
}

const CLAIM_RAIL = `
local activeRaw = redis.call('GET', KEYS[1])
local mappedParent = redis.call('GET', KEYS[3])
if not activeRaw or not mappedParent then return tonumber(ARGV[1]) end
local ok, active = pcall(cjson.decode, activeRaw)
if not ok or type(active) ~= ARGV[2] or active.version ~= tonumber(ARGV[3]) or
    active.parentIntentId ~= ARGV[4] or mappedParent ~= ARGV[4] then
  return tonumber(ARGV[5])
end
if active.selectedRail then
  if active.selectedRail == ARGV[6] and active.selectedIntentSalt == ARGV[7] and
      active.authorizationHash == ARGV[8] then
    return tonumber(ARGV[9])
  end
  return tonumber(ARGV[10])
end
active.selectedRail = ARGV[6]
active.selectedIntentSalt = ARGV[7]
active.selectedIntentKey = ARGV[11]
active.authorizationHash = ARGV[8]
local selectedRaw = cjson.encode(active)
local archived = redis.call('GET', KEYS[2])
if archived and archived ~= selectedRaw then return tonumber(ARGV[5]) end
redis.call('SET', KEYS[1], selectedRaw, 'EX', ARGV[13])
redis.call('SET', KEYS[2], selectedRaw)
redis.call('EXPIRE', KEYS[3], ARGV[13])
return tonumber(ARGV[12])
`;

export async function claimStoreRailSelection(input: {
  parentIntentId: string;
  intentSalt: Hex;
  intentKey: string;
  payer: Address;
  resourceId: string;
  contentRevision: number;
  rail: StorePaymentRail;
  authorizationHash: string;
}): Promise<
  | { ok: true; kind: 'claimed' | 'idempotent' }
  | { ok: false; reason: 'conflict' | 'storage' | 'corrupt' | 'not_found' }
> {
  if (
    !/^[0-9a-f]{64}$/.test(input.parentIntentId) ||
    !/^0x[0-9a-f]{64}$/.test(input.intentSalt) ||
    !HASH_RE.test(input.authorizationHash)
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  const result = await kvEval<number>(
    CLAIM_RAIL,
    [
      activeRailParentKey(
        input.payer,
        input.resourceId,
        input.contentRevision,
      ),
      railParentArchiveKey(input.parentIntentId),
      railIntentParentKey(input.intentSalt),
    ],
    [
      '0',
      'table',
      String(RAIL_PARENT_VERSION),
      input.parentIntentId,
      '-3',
      input.rail,
      input.intentSalt,
      input.authorizationHash,
      '2',
      '-1',
      input.intentKey,
      '1',
      String(RAIL_SELECTED_TTL_SEC),
    ],
  );
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === 1) return { ok: true, kind: 'claimed' };
  if (result.value === 2) return { ok: true, kind: 'idempotent' };
  if (result.value === 0) return { ok: false, reason: 'not_found' };
  if (result.value === -1) return { ok: false, reason: 'conflict' };
  return { ok: false, reason: 'corrupt' };
}

const RELEASE_ACTIVE_RAIL = `
local activeRaw = redis.call('GET', KEYS[1])
if not activeRaw then return 0 end
local ok, active = pcall(cjson.decode, activeRaw)
if not ok or type(active) ~= ARGV[1] then return -1 end
if active.parentIntentId ~= ARGV[2] or active.selectedRail ~= ARGV[3] or
    active.selectedIntentSalt ~= ARGV[4] or active.authorizationHash ~= ARGV[5] then
  return -2
end
return redis.call('DEL', KEYS[1])
`;

/** terminal intent だけが active slot を解放する。archive は監査用に恒久保持する。 */
export async function releaseActiveStoreRail(input: {
  parentIntentId: string;
  intentSalt: Hex;
  payer: Address;
  resourceId: string;
  contentRevision: number;
  rail: StorePaymentRail;
  authorizationHash: string;
}): Promise<boolean> {
  const result = await kvEval<number>(
    RELEASE_ACTIVE_RAIL,
    [
      activeRailParentKey(
        input.payer,
        input.resourceId,
        input.contentRevision,
      ),
    ],
    [
      'table',
      input.parentIntentId,
      input.rail,
      input.intentSalt,
      input.authorizationHash,
    ],
  );
  return result.ok && (result.value === 0 || result.value === 1);
}
