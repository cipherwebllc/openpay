import 'server-only';

import { kvEval, kvGet, kvMget } from '@/lib/kv';
import { isHostedId } from '@/lib/x402/hostedStore';
import {
  purchaseLibraryKey,
  purchaseOwnershipKey,
  type PurchaseGrant,
} from '@/lib/x402/purchaseIntent';
import {
  parseStorePurchaseOwnership,
  type StorePurchaseGrant,
  type StorePurchaseOwnership,
  type StoreUsdcPaymentSnapshot,
} from '@/lib/x402/storePaymentSnapshot';

export const STORE_LIBRARY_PAGE_SIZE = 24;

type LibraryCursor = {
  score: number;
  member: string;
};

export type StoreLibraryItem = {
  resourceId: string;
  title: string;
  desc?: string;
  emoji?: string;
  priceJpyc: string;
  contentKind: 'url' | 'text';
  label: 'download' | 'pdf' | 'zip' | 'prompt' | 'api' | 'external';
  purchasedAt: number;
  contentRevision: number;
  payment?: StoreUsdcPaymentSnapshot;
  revisions: StoreLibraryRevision[];
};

export type StoreLibraryRevision = {
  contentRevision: number;
  title: string;
  desc?: string;
  emoji?: string;
  priceJpyc: string;
  contentKind: 'url' | 'text';
  label: 'download' | 'pdf' | 'zip' | 'prompt' | 'api' | 'external';
  purchasedAt: number;
  payment?: StoreUsdcPaymentSnapshot;
};

export type StoreLibraryPage = {
  items: StoreLibraryItem[];
  nextCursor: string | null;
};

export type StoreLibraryPageResult =
  | { ok: true; page: StoreLibraryPage }
  | { ok: false; reason: 'invalid_cursor' | 'storage' | 'corrupt' };

const LIBRARY_CURSOR_MAX_LENGTH = 256;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function encodeLibraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeLibraryCursor(raw: string): LibraryCursor | null {
  if (
    raw.length === 0 ||
    raw.length > LIBRARY_CURSOR_MAX_LENGTH ||
    !BASE64URL_RE.test(raw)
  ) {
    return null;
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) return null;
    decoded = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded)
  ) {
    return null;
  }
  const value = decoded as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    !Number.isSafeInteger(value.score) ||
    (value.score as number) < 0 ||
    !isHostedId(value.member)
  ) {
    return null;
  }
  return {
    score: value.score as number,
    member: value.member,
  };
}

// cursor member の現在 rank を毎回引き直し、その直後から読む。library は削除 API を
// 持たないため、新規購入が cursor より前へ追加されても duplicate / skip を起こさない。
// ZREVRANGE は score 降順、同 score は member の逆 lexicographical 順を保証する。
const READ_LIBRARY_PAGE = `
local keyType = redis.call('TYPE', KEYS[1])
if type(keyType) == ARGV[6] then
  keyType = keyType.ok
end
if keyType ~= ARGV[4] and keyType ~= ARGV[5] then
  return {ARGV[7]}
end

local start = 0
if ARGV[1] == ARGV[8] then
  local score = redis.call('ZSCORE', KEYS[1], ARGV[3])
  if not score or tonumber(score) ~= tonumber(ARGV[2]) then
    return {ARGV[9]}
  end
  local rank = redis.call('ZREVRANK', KEYS[1], ARGV[3])
  if not rank then
    return {ARGV[9]}
  end
  start = rank + 1
end

return redis.call('ZREVRANGE', KEYS[1], start, start + tonumber(ARGV[10]) - 1,
  'WITHSCORES')
`;

const LIBRARY_STORAGE_SENTINEL = '__storage__';
const LIBRARY_CURSOR_SENTINEL = '__cursor__';

type LibraryIndexEntry = {
  member: string;
  score: number;
};

function parseIndexEntries(raw: unknown): LibraryIndexEntry[] | null {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  const entries: LibraryIndexEntry[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const member = raw[index];
    const scoreRaw = raw[index + 1];
    if (
      typeof member !== 'string' ||
      !isHostedId(member) ||
      typeof scoreRaw !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(scoreRaw)
    ) {
      return null;
    }
    const score = Number(scoreRaw);
    if (!Number.isSafeInteger(score) || score < 0) return null;
    entries.push({ member, score });
  }
  return entries;
}

function libraryRevision(grant: StorePurchaseGrant): StoreLibraryRevision {
  return {
    contentRevision: grant.contentRevision,
    title: grant.metadata.title,
    ...(grant.metadata.desc === undefined
      ? {}
      : { desc: grant.metadata.desc }),
    ...(grant.metadata.emoji === undefined
      ? {}
      : { emoji: grant.metadata.emoji }),
    priceJpyc: grant.metadata.priceJpyc,
    contentKind: grant.metadata.contentKind,
    label: grant.metadata.label,
    purchasedAt: grant.purchasedAt,
    ...(grant.payment ? { payment: grant.payment } : {}),
  };
}

/**
 * 同じ revision の再購入は content 選択肢を重複させず、その revision を最後に購入した
 * grant の安全な metadata を表示する。秘密でない表示項目だけを API へ渡す。
 */
function libraryRevisions(
  ownership: StorePurchaseOwnership,
): StoreLibraryRevision[] {
  const latestByRevision = new Map<number, StorePurchaseGrant>();
  for (const grant of ownership.grants) {
    const current = latestByRevision.get(grant.contentRevision);
    if (!current || grant.purchasedAt > current.purchasedAt) {
      latestByRevision.set(grant.contentRevision, grant);
    }
  }
  return [...latestByRevision.values()]
    .sort((left, right) => {
      if (left.contentRevision !== right.contentRevision) {
        return left.contentRevision > right.contentRevision ? -1 : 1;
      }
      if (left.purchasedAt !== right.purchasedAt) {
        return left.purchasedAt > right.purchasedAt ? -1 : 1;
      }
      return 0;
    })
    .map(libraryRevision);
}

function libraryItem(
  ownership: StorePurchaseOwnership,
): StoreLibraryItem {
  const grant = ownership.latestGrant;
  return {
    resourceId: ownership.resourceId,
    ...libraryRevision(grant),
    revisions: libraryRevisions(ownership),
  };
}

/**
 * content API 用の grant 選択。intentSalt は現在購入の read-back を過去の own で
 * 偽成功させない exact selector、revision はライブラリから過去版を開く selector。
 */
export function selectStorePurchaseGrant(
  ownership: StorePurchaseOwnership,
  selector: {
    revision: number | null;
    intentSalt: string | null;
  },
): PurchaseGrant | null {
  if (selector.intentSalt !== null) {
    const exact = ownership.grants.find(
      (grant) => grant.intentSalt === selector.intentSalt,
    );
    if (
      !exact ||
      (selector.revision !== null &&
        exact.contentRevision !== selector.revision)
    ) {
      return null;
    }
    return exact;
  }
  if (selector.revision === null) return ownership.latestGrant;

  let selected: PurchaseGrant | null = null;
  for (const grant of ownership.grants) {
    if (
      grant.contentRevision === selector.revision &&
      (!selected || grant.purchasedAt > selected.purchasedAt)
    ) {
      selected = grant;
    }
  }
  return selected;
}

/**
 * 恒久 library ZSET を score/member 降順で読む。
 * cursor は直前ページの末尾 tuple を含み、次ページはその tuple を exclusive に開始する。
 */
export async function listStoreLibraryPage(input: {
  payer: string;
  cursor: string | null;
}): Promise<StoreLibraryPageResult> {
  const cursor =
    input.cursor === null ? null : decodeLibraryCursor(input.cursor);
  if (input.cursor !== null && !cursor) {
    return { ok: false, reason: 'invalid_cursor' };
  }

  const indexResult = await kvEval<unknown>(
    READ_LIBRARY_PAGE,
    [purchaseLibraryKey(input.payer)],
    [
      cursor ? '1' : '0',
      cursor ? String(cursor.score) : '0',
      cursor?.member ?? '',
      'none',
      'zset',
      'table',
      LIBRARY_STORAGE_SENTINEL,
      '1',
      LIBRARY_CURSOR_SENTINEL,
      String(STORE_LIBRARY_PAGE_SIZE + 1),
    ],
  );
  if (!indexResult.ok) return { ok: false, reason: 'storage' };
  if (
    Array.isArray(indexResult.value) &&
    indexResult.value.length === 1 &&
    indexResult.value[0] === LIBRARY_STORAGE_SENTINEL
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  if (
    Array.isArray(indexResult.value) &&
    indexResult.value.length === 1 &&
    indexResult.value[0] === LIBRARY_CURSOR_SENTINEL
  ) {
    return { ok: false, reason: 'invalid_cursor' };
  }

  const indexed = parseIndexEntries(indexResult.value);
  if (!indexed) return { ok: false, reason: 'corrupt' };
  const visible = indexed.slice(0, STORE_LIBRARY_PAGE_SIZE);
  if (visible.length === 0) {
    return {
      ok: true,
      page: { items: [], nextCursor: null },
    };
  }

  const ownershipResult = await kvMget(
    visible.map(({ member }) =>
      purchaseOwnershipKey(input.payer, member),
    ),
  );
  if (
    !ownershipResult.ok ||
    !Array.isArray(ownershipResult.value) ||
    ownershipResult.value.length !== visible.length
  ) {
    return { ok: false, reason: 'storage' };
  }

  const ownerships: StorePurchaseOwnership[] = [];
  for (let index = 0; index < visible.length; index += 1) {
    const entry = visible[index]!;
    const raw = ownershipResult.value[index];
    const ownership = parseStorePurchaseOwnership(raw);
    if (
      !ownership ||
      ownership.payer.toLowerCase() !== input.payer.toLowerCase() ||
      ownership.resourceId !== entry.member ||
      ownership.firstPurchasedAt !== entry.score
    ) {
      return { ok: false, reason: 'corrupt' };
    }
    ownerships.push(ownership);
  }

  const last = visible.at(-1)!;
  return {
    ok: true,
    page: {
      items: ownerships.map(libraryItem),
      nextCursor:
        indexed.length > STORE_LIBRARY_PAGE_SIZE
          ? encodeLibraryCursor({
              score: last.score,
              member: last.member,
            })
          : null,
    },
  };
}

export type StoreOwnershipReadResult =
  | { ok: true; ownership: StorePurchaseOwnership | null }
  | { ok: false; reason: 'storage' | 'corrupt' };

/** content route が本文より先に行う authoritative own key read。 */
export async function readStoreOwnership(
  payer: string,
  resourceId: string,
): Promise<StoreOwnershipReadResult> {
  if (!isHostedId(resourceId)) {
    return { ok: true, ownership: null };
  }
  const result = await kvGet(purchaseOwnershipKey(payer, resourceId));
  if (!result.ok) return { ok: false, reason: 'storage' };
  if (result.value === null) return { ok: true, ownership: null };
  const ownership = parseStorePurchaseOwnership(result.value);
  if (
    !ownership ||
    ownership.payer.toLowerCase() !== payer.toLowerCase() ||
    ownership.resourceId !== resourceId
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  return { ok: true, ownership };
}
