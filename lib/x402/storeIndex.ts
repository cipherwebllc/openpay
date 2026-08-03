import 'server-only';

// OpenPay Store の横断掲載インデックス (plans/store-marketplace.md P2)。
//
// 設計原則: **index はヒントであり、真実は商品レコード側**。
//   - 書込は出品成功後の best-effort (no-throw)。掲載インデックスの障害を出品/編集の
//     本体 (既存 Lua CAS) に波及させない (掟 13)。失敗時は「Store に表示されない」
//     方向へ倒れ (fail-open は表示しない側)、次回の編集か backfill で自己回復する。
//   - 読出は index の id 列 → 商品レコードを権威として再検証 (saleActive /
//     contentAvailable / ブロックリスト)。したがって index に残留した古い id は
//     表示されないだけで無害 → 削除フックが不要になり、既存の商品 Lua に 1 行も
//     触れない (掟 12)。
//
// key 空間 (hostedStore の `x402:hosted:*` に併設・external registry とは不干渉):
//   x402:hosted:store:index      → zset (score = updatedAt ms, member = product id)
//   x402:hosted:store:blocklist  → set (運営が除外する product id。KV へ手動 SADD)

import { kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';

// hostedStore と同じ id 形式 (h_ + 128bit hex)。regex をローカルに持つのは
// hostedStore への import を作らないため — 広く mock される module に依存すると
// 兄弟テストの vi.mock が新 export を欠いて壊れる (掟 6)。形式は
// tests/lib/x402/storeIndex.test.ts が hostedStore 側の isHostedId と突き合わせる。
const HOSTED_ID_RE = /^h_[0-9a-f]{32}$/;
function isHostedIndexId(value: unknown): value is string {
  return typeof value === 'string' && HOSTED_ID_RE.test(value);
}

export const STORE_INDEX_KEY = 'x402:hosted:store:index';
export const STORE_BLOCKLIST_KEY = 'x402:hosted:store:blocklist';

/** Store 一覧が一度に読む id 数の上限 (MVP: 全件想定・暴走防止の天井)。 */
export const STORE_INDEX_MAX_IDS = 200;

const TOUCH_INDEX = `
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
return 1
`;

/**
 * 出品/編集の成功後に掲載インデックスを更新する (newest-first の score 更新)。
 * **no-throw**: 出品本体は既に成功しており、ここでの障害は掲載の遅延にしかならない。
 */
export async function touchStoreIndex(id: string, updatedAtMs: number): Promise<void> {
  if (!isHostedIndexId(id)) return;
  try {
    const res = await kvEval<number>(
      TOUCH_INDEX,
      [STORE_INDEX_KEY],
      [id, String(updatedAtMs)],
    );
    if (!res.ok) {
      logger.warn('store.index.touch_failed', { id });
    }
  } catch {
    logger.warn('store.index.touch_failed', { id });
  }
}

const LIST_INDEX = `
local ids = redis.call('ZREVRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
local out = {}
for i = 1, #ids do
  if redis.call('SISMEMBER', KEYS[2], ids[i]) == 0 then
    out[#out + 1] = ids[i]
  end
end
return out
`;

/**
 * 掲載候補の id を新着 (updatedAt) 順で返す。ブロックリスト (運営除外) は
 * ここで落とす。**呼び出し側は必ず商品レコードを再検証すること** (この関数は
 * ヒントの列でしかない)。KV 障害は null (空とは区別し、呼び出し側が 503 に倒す)。
 */
export async function listStoreIndexIds(
  limit = STORE_INDEX_MAX_IDS,
): Promise<string[] | null> {
  const capped = Math.max(1, Math.min(limit, STORE_INDEX_MAX_IDS));
  const res = await kvEval<unknown>(
    LIST_INDEX,
    [STORE_INDEX_KEY, STORE_BLOCKLIST_KEY],
    [String(capped)],
  );
  if (!res.ok || !Array.isArray(res.value)) return null;
  return res.value.filter(isHostedIndexId);
}
