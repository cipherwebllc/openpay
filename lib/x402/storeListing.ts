import 'server-only';
import type { StoreLicenseSummary, SellerRole } from '@/lib/licenseUi';
import { env } from '@/lib/env';
import { sellerRoleFor } from '@/lib/license/sellerRole';
import { licenseSummariesFor } from '@/lib/license/display';

// /store 一覧 (P3) の組み立て。plans/store-marketplace.md。
//
// データフロー: 掲載インデックス (ヒント) → 商品レコード (権威・saleActive 等を再検証)
// → owner の @handle 解決。**handle を持たない owner の商品は掲載しない** —
// 契約は「プロフィールで公開した商品が Store にも載る」であり、Store カードの
// 遷移先も @handle の商品 deep link (購入面を新設しない = money-path 不変)。

import { formatUnits } from 'viem';
import { parseDeliveryUrl } from '@/lib/store/deliveryUrl';
import { listHandlesForOwner } from '@/lib/handleStore';
import { hostedPurchaseFeeValue } from '@/lib/x402/hostedPurchaseWire';
import {
  getHostedProductsByIds,
  type HostedProduct,
} from '@/lib/x402/hostedStore';
import { listStoreIndexIds } from '@/lib/x402/storeIndex';

/** Store カードの描画に必要な公開情報のみ (owner ウォレットは client へ渡さない)。 */
export type StoreListing = {
  protectedDelivery?: boolean;
  productKind?: 'license';
  license?: StoreLicenseSummary;
  sellerRole?: SellerRole;
  id: string;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  priceJpyc: string;
  /** 保存値 true のときだけ Base USDC rail を提示できる。 */
  usdcEnabled?: true;
  label: HostedProduct['label'];
  /** 納品の種類 (url = 配布先の URL・text = 本文)。label と合わせて納品形式 (lib/store/deliveryFormat) を決める。 */
  contentKind: HostedProduct['contentKind'];
  /** 表示専用の詳細 (@handle の商品ページで公開済み・購入 snapshot 非対象)。公開一覧 API (AI 向け) にだけ渡し、
   * /store のカードには渡さない (toStoreCardListing で落とす・HTML を太らせない)。 */
  details?: string;
  specs?: readonly { label: string; value: string }[];
  demoUrl?: string;
  /** 出品者が選んだ利用条件 (同上・表示専用)。 */
  usage?: HostedProduct['usage'];
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

/** /store のカード (client) に渡す形。AI 向けの表示専用の詳細は渡さない。 */
export type StoreCardListing = Omit<StoreListing, 'contentKind' | 'details' | 'specs' | 'demoUrl' | 'usage'>;

/** /store のカードへ渡す前に、カードに要らない AI 向けの詳細を落とす (/store の HTML を増やさない)。 */
export function toStoreCardListing(listing: StoreListing): StoreCardListing {
  const { contentKind: _contentKind, details: _details, specs: _specs, demoUrl: _demoUrl, usage: _usage, ...card } = listing;
  return card;
}

/**
 * 掲載一覧 (newest-first)。KV 障害は null (空と区別し、呼び出し側がエラー表示に倒す)。
 * owner→handle は unique owner ごとに 1 read (MVP 規模で N+1 許容・
 * listAvailableHostedForOwner と同じ判断)。handle 解決に失敗した owner の商品は
 * 「表示されない」方向へ倒す (誤掲載よりも欠落を選ぶ・fail-open は表示しない側)。
 */
export async function listStoreListings(): Promise<StoreListing[] | null> {
  // 同一 owner の商品が同じページや後続ページに並んでも handle は一度だけ取得する。
  const handleLookups = new Map<string, Promise<string[] | null>>();
  function handlesForOwner(owner: string): Promise<string[] | null> {
    const key = owner.toLowerCase();
    let lookup = handleLookups.get(key);
    if (!lookup) {
      lookup = listHandlesForOwner(key);
      handleLookups.set(key, lookup);
    }
    return lookup;
  }
  const ids = await listStoreIndexIds(undefined, async (product) => {
    const handles = await handlesForOwner(product.owner);
    return handles !== null && handles.length > 0;
  });
  if (ids === null) return null;
  if (ids.length === 0) return [];
  // ページ走査中の非公開化が掲載へ波及しないよう、選択した商品だけを再検証する。
  const products = await getHostedProductsByIds(ids);
  if (products === 'storage') return null;
  if (products.length === 0) return [];

  const owners = Array.from(
    new Set(products.map((product) => product.owner.toLowerCase())),
  );
  const handlesByOwner = new Map<string, string[]>();
  const [licenseSummaries] = await Promise.all([
    env.enableLicenseNftUi ? licenseSummariesFor(products) : Promise.resolve(new Map()),
    Promise.all(owners.map(async (owner) => {
      const handles = await handlesForOwner(owner);
      if (handles && handles.length > 0) {
        handlesByOwner.set(owner, handles);
      }
    })),
  ]);

  const out: StoreListing[] = [];
  for (const product of products) {
    const ownedHandles = handlesByOwner.get(product.owner.toLowerCase());
    if (!ownedHandles || ownedHandles.length === 0) continue;
    // 帰属: 商品の掲載先 handle が現に owner の所有なら最優先 (誤帰属修正
    // 2026-08-04)。解放済み等で所有から外れていれば従来どおり先頭 handle。
    const handle =
      product.handle && ownedHandles.includes(product.handle)
        ? product.handle
        : ownedHandles[0];
    out.push({
      id: product.id,
      protectedDelivery: parseDeliveryUrl(product.deliveryUrl).ok,
      ...(product.productKind === 'license' && product.license ? {
        productKind: product.productKind,
        sellerRole: sellerRoleFor(product.owner),
        ...(licenseSummaries.has(product.id) ? { license: licenseSummaries.get(product.id) } : {}),
      } : {}),
      title: product.title,
      ...(product.desc ? { desc: product.desc } : {}),
      ...(product.emoji ? { emoji: product.emoji } : {}),
      ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
      priceJpyc: product.priceJpyc,
      ...(product.usdcEnabled === true ? { usdcEnabled: true } : {}),
      label: product.label,
      contentKind: product.contentKind,
      ...(product.details ? { details: product.details } : {}),
      ...(product.specs?.length ? { specs: product.specs } : {}),
      ...(product.demoUrl ? { demoUrl: product.demoUrl } : {}),
      ...(product.usage ? { usage: product.usage } : {}),
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
