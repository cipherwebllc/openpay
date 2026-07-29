import 'server-only';

import {
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { kvDel, kvEval, kvLrange } from '@/lib/kv';

export const TIP_MESSAGE_MAX_CODE_POINTS = 300;
export const TIP_MESSAGE_LIST_MAX = 200;
export const TIP_MESSAGE_TTL_SEC = 180 * 24 * 60 * 60;
export const TIP_MESSAGE_MIN_AMOUNT_WEI = 10n ** 18n;

const UINT256_MAX = (1n << 256n) - 1n;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^(0|[1-9]\d*)$/;
const UNSAFE_UNICODE_RE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export type StoredTipMessage = {
  from: Address;
  to: Address;
  amountWei: string;
  chainId: number;
  txHash: Hex;
  message: string;
  ts: number;
};

export type StoreTipMessageInput = {
  from: Address | string;
  to: Address | string;
  amountWei: bigint;
  chainId: number;
  txHash: Hex | string;
  message: string;
  ts?: number;
};

const STORE_TIP_MESSAGE = `
local chainId = tonumber(ARGV[4])
local txHash = string.lower(ARGV[5])
local rows = redis.call('LRANGE', KEYS[1], 0, 199)
for _, raw in ipairs(rows) do
  local ok, item = pcall(cjson.decode, raw)
  if ok and type(item) == 'table'
    and tonumber(item.chainId) == chainId
    and type(item.txHash) == 'string'
    and string.lower(item.txHash) == txHash then
    return 0
  end
end
local record = cjson.encode({
  from = ARGV[1],
  to = ARGV[2],
  amountWei = ARGV[3],
  chainId = chainId,
  txHash = ARGV[5],
  message = ARGV[6],
  ts = tonumber(ARGV[7])
})
redis.call('LPUSH', KEYS[1], record)
redis.call('LTRIM', KEYS[1], 0, 199)
redis.call('EXPIRE', KEYS[1], ARGV[8])
return 1
`;

export function tipMessageInboxKey(to: Address | string): string {
  return `tipmsg:${to.toLowerCase()}`;
}

/**
 * Private message input normalization. LF is the sole retained control
 * character; CRLF/CR are canonicalized to LF. Other control/format/surrogate
 * code points (including zero-width and bidi controls) are removed.
 *
 * The cap is evaluated after normalization in Unicode code points. Overlong
 * input is rejected rather than truncated so the server never silently
 * changes the sender's message.
 */
export function sanitizeTipMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalizedNewlines = raw.replace(/\r\n?/g, '\n');
  const message = [...normalizedNewlines]
    .filter((char) => char === '\n' || !UNSAFE_UNICODE_RE.test(char))
    .join('')
    .trim();
  const length = [...message].length;
  if (length === 0 || length > TIP_MESSAGE_MAX_CODE_POINTS) return undefined;
  return message;
}

export function parseStoredTipMessage(raw: unknown): StoredTipMessage | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const from = parseAddress(record.from);
  const to = parseAddress(record.to);
  if (!from || !to) return null;
  if (
    typeof record.amountWei !== 'string' ||
    record.amountWei.length > 78 ||
    !DECIMAL_RE.test(record.amountWei)
  ) {
    return null;
  }
  const amountWei = BigInt(record.amountWei);
  if (amountWei < TIP_MESSAGE_MIN_AMOUNT_WEI || amountWei > UINT256_MAX) {
    return null;
  }
  if (
    typeof record.chainId !== 'number' ||
    !Number.isSafeInteger(record.chainId) ||
    record.chainId <= 0
  ) {
    return null;
  }
  if (typeof record.txHash !== 'string' || !TX_HASH_RE.test(record.txHash)) {
    return null;
  }
  if (typeof record.message !== 'string') return null;
  const message = sanitizeTipMessage(record.message);
  if (message === undefined || message !== record.message) return null;
  if (
    typeof record.ts !== 'number' ||
    !Number.isSafeInteger(record.ts) ||
    record.ts <= 0
  ) {
    return null;
  }

  return {
    from,
    to,
    amountWei: record.amountWei,
    chainId: record.chainId,
    txHash: record.txHash as Hex,
    message,
    ts: record.ts,
  };
}

export async function storeTipMessage(
  input: StoreTipMessageInput,
): Promise<boolean> {
  const from = parseAddress(input.from);
  const to = parseAddress(input.to);
  const message = sanitizeTipMessage(input.message);
  const ts = input.ts ?? Date.now();
  if (
    !from ||
    !to ||
    input.amountWei < TIP_MESSAGE_MIN_AMOUNT_WEI ||
    input.amountWei > UINT256_MAX ||
    !Number.isSafeInteger(input.chainId) ||
    input.chainId <= 0 ||
    !TX_HASH_RE.test(input.txHash) ||
    !message ||
    !Number.isSafeInteger(ts) ||
    ts <= 0
  ) {
    return false;
  }

  try {
    const result = await kvEval<number>(
      STORE_TIP_MESSAGE,
      [tipMessageInboxKey(to)],
      [
        from,
        to,
        input.amountWei.toString(),
        String(input.chainId),
        input.txHash,
        message,
        String(ts),
        String(TIP_MESSAGE_TTL_SEC),
      ],
    );
    return result.ok && result.value === 1;
  } catch {
    // Private-message storage is ancillary: an unexpected KV exception must
    // never propagate into the already-successful payment path.
    return false;
  }
}

export async function listTipMessages(
  to: Address | string,
): Promise<StoredTipMessage[] | null> {
  const owner = parseAddress(to);
  if (!owner) return null;
  try {
    const result = await kvLrange(
      tipMessageInboxKey(owner),
      0,
      TIP_MESSAGE_LIST_MAX - 1,
    );
    if (!result.ok) return null;
    const ownerLower = owner.toLowerCase();
    return (result.value ?? [])
      .map(parseStoredTipMessage)
      .filter(
        (item): item is StoredTipMessage =>
          item !== null && item.to.toLowerCase() === ownerLower,
      );
  } catch {
    // A read-side KV exception is reported as unavailable, not as an empty
    // inbox, so an outage cannot erase the owner's visible state.
    return null;
  }
}

export async function deleteTipMessages(
  to: Address | string,
): Promise<boolean> {
  const owner = parseAddress(to);
  if (!owner) return false;
  try {
    const result = await kvDel(tipMessageInboxKey(owner));
    return result.ok;
  } catch {
    // A deletion storage exception must stay within inbox maintenance and be
    // surfaced by the API as unavailable rather than escaping as an opaque 500.
    return false;
  }
}

function parseAddress(value: unknown): Address | null {
  if (typeof value !== 'string' || !isAddress(value)) return null;
  return getAddress(value);
}
