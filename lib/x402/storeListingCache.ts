import 'server-only';
// /store の掲載一覧を 60 秒だけ共有キャッシュする (Upstash 無料枠の KV 予算・2026-09-26)。
// listStoreListings は 1 回で index 走査・商品の読み込み・owner ごとの handle 解決・license 在庫を読み、
// 表示 1 回で数十コマンドを使う。/store は検索エンジン等の巡回も受けるので、公開データに限って共有する。
// - 出品・非公開化・価格変更の反映は最大 60 秒遅れる。購入時は商品と在庫をその場で読み直すので、
//   キャッシュの古さが決済や在庫の判定へ波及することはない。
// - KV 障害 (null) はキャッシュしない: 例外で unstable_cache を抜け、次の表示で読み直す。
import { unstable_cache } from 'next/cache';
import { listStoreListings, type StoreListing } from '@/lib/x402/storeListing';

export const STORE_LISTINGS_REVALIDATE_SEC = 60;

class StoreListingsUnavailable extends Error {}

const cachedStoreListings = unstable_cache(
  async (): Promise<StoreListing[]> => {
    const listings = await listStoreListings();
    if (listings === null) throw new StoreListingsUnavailable();
    return listings;
  },
  ['store-listings-v1'],
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
