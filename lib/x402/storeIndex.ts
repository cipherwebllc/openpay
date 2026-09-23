import 'server-only';

// OpenPay Store の横断掲載インデックス (plans/store-marketplace.md P2)。
//
// 設計原則: **index はヒントであり、真実は商品レコード側**。
//   - 書込は出品成功後の best-effort (no-throw)。掲載インデックスの障害を出品/編集の
//     本体 (既存 Lua CAS) に波及させない (掟 13)。失敗時は「Store に表示されない」
//     方向へ倒れ (fail-open は表示しない側)、次回の編集か backfill で自己回復する。
//   - 読出は index の id 列 → 商品レコードを権威として再検証 (saleActive /
//     contentAvailable / ブロックリスト)。除外した id は公開枠を消費せず、次の
//     ページへ進む。既存の下書き混在 index をそのまま使い、商品 Lua は変更しない。
//
// key 空間 (hostedStore の `x402:hosted:*` に併設・external registry とは不干渉):
//   x402:hosted:store:index      → zset (score = updatedAt ms, member = product id)
//   x402:hosted:store:blocklist  → set (運営が除外する product id。KV へ手動 SADD)

import { kvEval } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { getHostedProductsByIds, type HostedProduct } from '@/lib/x402/hostedStore';

// 書込の id 検査はローカルに保つ。読出の公開可否は hostedStore の権威検証に委ねる。
// 以前は hostedStore を mock する route 群への依存波及を避けるため import しなかった
// (掟 6)。共通の公開判定が必要な読出だけを依存させ、書込側の検査はそのままにする。
const HOSTED_ID_RE = /^h_[0-9a-f]{32}$/;
function isHostedIndexId(value: unknown): value is string {
  return typeof value === 'string' && HOSTED_ID_RE.test(value);
}

export const STORE_INDEX_KEY = 'x402:hosted:store:index';
export const STORE_BLOCKLIST_KEY = 'x402:hosted:store:blocklist';

/** 公開候補数の上限。下書き等は枠を消費しない。 */
export const STORE_INDEX_MAX_IDS = 200;
const STORE_INDEX_PAGE_SIZE = 200;
// 匿名の一覧アクセスが蓄積した下書き等の全件走査へ増幅し、KV 負荷・応答遅延を
// 他の利用者へ波及させるのを防ぐ。最大 2,000 id までで、見つかった候補だけを返す。
const STORE_INDEX_MAX_PAGES = 10;

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
local offset = tonumber(ARGV[2])
local ids = redis.call('ZREVRANGE', KEYS[1], offset, offset + tonumber(ARGV[1]) - 1)
local out = {}
for i = 1, #ids do
  if redis.call('SISMEMBER', KEYS[2], ids[i]) == 0 then
    out[#out + 1] = ids[i]
  end
end
return {#ids, out}
`;

/**
 * 公開候補の id を新着 (updatedAt) 順で返す。下書き・運営除外・呼出側の追加条件を
 * 落としてから件数を制限する。最大 10 ページまでを走査する。
 * **呼び出し側は必ず商品レコードを再検証すること** (走査後の
 * 非公開化もあり得る)。KV 障害は null (空とは区別し、呼び出し側が 503 に倒す)。
 */
export async function listStoreIndexIds(
  limit = STORE_INDEX_MAX_IDS,
  includeProduct?: (product: HostedProduct) => Promise<boolean>,
): Promise<string[] | null> {
  const capped = Math.max(1, Math.min(limit, STORE_INDEX_MAX_IDS));
  const ids = new Set<string>();
  for (let page = 0; page < STORE_INDEX_MAX_PAGES && ids.size < capped; page++) {
    const res = await kvEval<unknown>(
      LIST_INDEX,
      [STORE_INDEX_KEY, STORE_BLOCKLIST_KEY],
      [String(STORE_INDEX_PAGE_SIZE), String(page * STORE_INDEX_PAGE_SIZE)],
    );
    if (!res.ok || !Array.isArray(res.value)) return null;
    const [scanned, candidates] = res.value;
    // 壊れた KV ページを正常な空一覧や際限のないページ走査へ波及させない。
    if (!Number.isInteger(scanned) || scanned < 0 || scanned > STORE_INDEX_PAGE_SIZE || !Array.isArray(candidates)) return null;
    const products = await getHostedProductsByIds(candidates.filter(isHostedIndexId));
    if (products === 'storage') return null;
    const included = includeProduct ? await Promise.all(products.map(includeProduct)) : null;
    for (const [index, product] of products.entries()) {
      if (included && !included[index]) continue;
      // ページ間の更新で同じ id が再登場しても公開枠を二重に消費させない。
      ids.add(product.id);
      if (ids.size === capped) break;
    }
    if (scanned < STORE_INDEX_PAGE_SIZE) break;
  }
  return [...ids];
}
