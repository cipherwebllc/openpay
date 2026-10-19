import 'server-only';
// /store の掲載一覧を 60 秒だけ共有キャッシュする (Upstash 無料枠の KV 予算・2026-09-26)。
// listStoreListings は 1 回で index 走査・商品の読み込み・owner ごとの handle 解決・license 在庫を読み、
// 表示 1 回で数十コマンドを使う。/store は検索エンジン等の巡回も受けるので、公開データに限って共有する。
// - 出品・非公開化・価格変更の反映は最大 60 秒遅れる。購入時は商品と在庫をその場で読み直すので、
//   キャッシュの古さが決済や在庫の判定へ波及することはない。
// - KV 障害 (null) はキャッシュしない: 例外で unstable_cache を抜け、次の表示で読み直す。
// - 1 件の大きさ: AI 向けの表示専用の詳細 (details ≤2000 字・specs ≤8 行) も入る (公開一覧 API 用)。Vercel Data Cache は
//   1 item 2 MB が上限で、超えると黙ってキャッシュされず毎回 KV を読む (Upstash の予算を食う)。文字数の上限は
//   直列化後の大きさを縛らない (エスケープで 1 文字が数バイトになる・200 件で 2 MB を超えうる・Codex レビュー P2)。
//   そこで保存の前に大きさを測り、予算を超えたら AI 向けの詳細を大きい順 (details → specs) に落とす
//   (fitStoreListingsForCache)。一覧の本体 (価格・題名・購入リンク) は残し、キャッシュが黙って無効になる波及を断つ。
import { unstable_cache } from 'next/cache';
import { logger } from '@/lib/logger';
import { listStoreListings, type StoreListing } from '@/lib/x402/storeListing';

export const STORE_LISTINGS_REVALIDATE_SEC = 60;
/** キャッシュ 1 件の予算。Data Cache の上限 2 MB に、封筒 (JSON の二重直列化) の余白を残す。 */
export const STORE_LISTINGS_CACHE_BUDGET_BYTES = 1.5 * 1024 * 1024;

/** キャッシュに入る大きさの目安 (Next は値を JSON にし、さらに封筒の JSON に入れる)。 */
function cachedSizeBytes(listings: readonly StoreListing[]): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(listings)), 'utf8');
}

/**
 * 予算を超えるときは AI 向けの表示専用の詳細を落として収める (details → specs の順)。落とさずに済めば元のまま。
 * dropped は落とした項目 (監視用)。
 */
export function fitStoreListingsForCache(
  listings: readonly StoreListing[],
  budgetBytes: number = STORE_LISTINGS_CACHE_BUDGET_BYTES,
): { listings: StoreListing[]; dropped: ('details' | 'specs')[] } {
  let out = [...listings];
  const dropped: ('details' | 'specs')[] = [];
  for (const key of ['details', 'specs'] as const) {
    if (cachedSizeBytes(out) <= budgetBytes) break;
    out = out.map((listing) => {
      if (!(key in listing)) return listing;
      const { [key]: _dropped, ...rest } = listing;
      return rest as StoreListing;
    });
    dropped.push(key);
  }
  return { listings: out, dropped };
}

class StoreListingsUnavailable extends Error {}

const cachedStoreListings = unstable_cache(
  async (): Promise<StoreListing[]> => {
    const listings = await listStoreListings();
    if (listings === null) throw new StoreListingsUnavailable();
    const fitted = fitStoreListingsForCache(listings);
    if (fitted.dropped.length > 0) {
      // 掲載が増えて詳細が予算を超えた合図。詳細を別のキャッシュ (商品ごと) に分ける時期。
      logger.warn('store.listings_cache.trimmed', { count: listings.length, dropped: fitted.dropped.join(',') });
    }
    return fitted.listings;
  },
  ['store-listings-v2'],
  { revalidate: STORE_LISTINGS_REVALIDATE_SEC, tags: ['store-listings'] },
);

/** /store 用。KV 障害は null (呼び出し側はエラー表示に倒す・キャッシュしない)。 */
export async function listStoreListingsCached(): Promise<StoreListing[] | null> {
  try {
    return await cachedStoreListings();
  } catch (error) {
    if (error instanceof StoreListingsUnavailable) return null;
    throw error;
  }
}
