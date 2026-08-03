import 'server-only';

// /store 一覧 (P3) の組み立て。plans/store-marketplace.md。
//
// データフロー: 掲載インデックス (ヒント) → 商品レコード (権威・saleActive 等を再検証)
// → owner の @handle 解決。**handle を持たない owner の商品は掲載しない** —
// 契約は「プロフィールで公開した商品が Store にも載る」であり、Store カードの
// 遷移先も @handle の商品 deep link (購入面を新設しない = money-path 不変)。

import { formatUnits } from 'viem';
import { listHandlesForOwner } from '@/lib/handleStore';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';
import {
  getHostedProductsByIds,
  type HostedProduct,
} from '@/lib/x402/hostedStore';
import { listStoreIndexIds } from '@/lib/x402/storeIndex';

/** Store カードの描画に必要な公開情報のみ (owner ウォレットは client へ渡さない)。 */
export type StoreListing = {
  id: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  priceJpyc: string;
  label: HostedProduct['label'];
  category?: string;
  tags?: readonly string[];
  /** 出品者の公開 handle (先頭 1 件)。カードの遷移先 /@handle?product=id に使う。 */
  handle: string;
  updatedAt: number;
  /** 買い手の支払い合計 (価格 + x402 手数料)。式は hostedPurchaseFeeValue の単一ソース
   * (プロフカード/購入 hook と同一関数) を server で適用 — client に viem を持ち込まない。 */
  totalJpyc: string;
  feeJpyc: string;
};

/**
 * 掲載一覧 (newest-first)。KV 障害は null (空と区別し、呼び出し側がエラー表示に倒す)。
 * owner→handle は unique owner ごとに 1 read (MVP 規模で N+1 許容・
 * listAvailableHostedForOwner と同じ判断)。handle 解決に失敗した owner の商品は
 * 「表示されない」方向へ倒す (誤掲載よりも欠落を選ぶ・fail-open は表示しない側)。
 */
export async function listStoreListings(): Promise<StoreListing[] | null> {
  const ids = await listStoreIndexIds();
  if (ids === null) return null;
  if (ids.length === 0) return [];
  const products = await getHostedProductsByIds(ids);
  if (products === 'storage') return null;
  if (products.length === 0) return [];

  const owners = Array.from(
    new Set(products.map((product) => product.owner.toLowerCase())),
  );
  const handleByOwner = new Map<string, string>();
  await Promise.all(
    owners.map(async (owner) => {
      const handles = await listHandlesForOwner(owner);
      if (handles && handles.length > 0) {
        handleByOwner.set(owner, handles[0]);
      }
    }),
  );

  const out: StoreListing[] = [];
  for (const product of products) {
    const handle = handleByOwner.get(product.owner.toLowerCase());
    if (!handle) continue;
    out.push({
      id: product.id,
      title: product.title,
      ...(product.desc ? { desc: product.desc } : {}),
      ...(product.emoji ? { emoji: product.emoji } : {}),
      ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
      priceJpyc: product.priceJpyc,
      label: product.label,
      ...(product.category ? { category: product.category } : {}),
      ...(product.tags ? { tags: product.tags } : {}),
      handle,
      updatedAt: product.updatedAt ?? product.createdAt,
      totalJpyc: formatUnits(
        BigInt(product.priceJpyc) * 10n ** 18n +
          hostedPurchaseFeeValue(BigInt(product.priceJpyc) * 10n ** 18n),
        18,
      ),
      feeJpyc: formatUnits(
        hostedPurchaseFeeValue(BigInt(product.priceJpyc) * 10n ** 18n),
        18,
      ),
    });
  }
  return out;
}
