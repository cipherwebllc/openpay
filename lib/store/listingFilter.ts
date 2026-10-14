// Store 掲載一覧の絞り込み規則 (キーワード・カテゴリー・ライセンス商品の表示可否)。
// /store の StoreBrowser と公開一覧 API (/api/store/listings) が同じ規則で絞るための単一ソース
// (両者の検索結果が食い違わないよう、ここ以外に規則を書かない)。
// client にも入るので server 専用の依存を持たない (StoreListing は型だけ参照する)。

import { env } from '@/lib/env';
import type { StoreListing } from '@/lib/x402/storeListing';

type FilterableStoreListing = Pick<
  StoreListing,
  'productKind' | 'category' | 'title' | 'desc' | 'handle' | 'tags'
>;

/** 掲載順 (新着順) を保ったまま絞り込む。query は大文字小文字を区別しない部分一致。 */
export function filterStoreListings<T extends FilterableStoreListing>(
  listings: readonly T[],
  { query, category }: { query: string; category: string },
): T[] {
  const q = query.trim().toLowerCase();
  return listings.filter((listing) => {
    if (listing.productKind === 'license' && !env.enableLicenseNftUi) return false;
    if (category && listing.category !== category) return false;
    if (!q) return true;
    const haystack = [
      listing.title,
      listing.desc ?? '',
      // '@' 付きで持つ — プロフの「すべての商品を見る」リンク (?q=@handle) と
      // 素の handle 入力の両方に substring 一致させる
      `@${listing.handle}`,
      ...(listing.tags ?? []),
    ]
      .join('\n')
      .toLowerCase();
    return haystack.includes(q);
  });
}
