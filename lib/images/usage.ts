import 'server-only';

import { kvLrange, kvMget } from '@/lib/kv';
import { parseHandleRecord } from '@/lib/handle';
import { handleKey, ownerIndexKey } from '@/lib/handleStore';
import {
  MAX_HOSTED_PER_OWNER,
  hostedOwnerIndexKey,
  hostedProductKey,
  isHostedId,
  parseStoredHostedProduct,
} from '@/lib/x402/hostedStore';
import type { ImageUse } from '@/lib/images/library';

// アップロードした画像を「使っている所」(一覧の usedIn と、削除の前の 409 image_in_use)。server が読めるのは本人の記録だけ:
// - @handle: `wallet:handles:<wallet>` (LRANGE) → `handle:<name>` (MGET・最大 3)。プロフのアバター・カバー・リンクの画像と、
//   店舗 (モバイル注文) のアイコン・カバー・メニューの画像。
// - Store の商品: `x402:hosted:owner:<wallet>` (LRANGE) → `x402:hosted:<id>` (MGET・最大 24)。表紙と追加画像。販売停止・
//   非掲載・ライセンスの flag が off の商品も含める (ライセンス NFT の metadata は販売の後も今の表紙を返すので、消すと買った人の
//   画像が切れる)。
// 1 回の要求で 1 度だけ読む: KV は LRANGE 2 + MGET 0〜2 = 2〜4 コマンド (記録が無い種類は MGET を送らない)。
// 記録の読み方は表示する側と同じ parser (parseHandleRecord・parseStoredHostedProduct) で、owner (と商品の id) を確かめ直す
// (古い index が別のウォレットの記録を指していても、他人の記録を本人の使用先にしない)。
// 照合は URL の origin + path (query と fragment は外す)。用途 (purpose) をまたいで使っていても見つかる。
// 判定は読めた時点の記録まで: 読んだ後に公開した記録と、削除の del の間の競合は残る (受け入れる限界)。

export type ImageUsageIndex = {
  /** その公開 URL を使っている所 (無ければ空)。 */
  usesOf(url: string): ImageUse[];
};

/** 照合の key (https の origin + path)。読めない・https でない値は null (照合しない)。 */
export function imageUrlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? `${url.origin}${url.pathname}` : null;
}

function uniqueStrings(values: readonly string[], valid: (value: string) => boolean): string[] {
  return Array.from(new Set(values.filter(valid)));
}

/**
 * そのウォレットの記録を読んで、使っている所の索引を作る。どれか 1 つでも読めなければ null (呼び元は 503: 使っているかが
 * 分からないまま「使っていない」と言わない・消させない)。
 */
export async function readImageUsage(wallet: string): Promise<ImageUsageIndex | null> {
  const owner = wallet.toLowerCase();
  const [handleIndex, productIndex] = await Promise.all([
    kvLrange(ownerIndexKey(owner), 0, -1),
    kvLrange(hostedOwnerIndexKey(owner), 0, MAX_HOSTED_PER_OWNER - 1),
  ]);
  if (!handleIndex.ok || !productIndex.ok) return null;
  const handles = uniqueStrings(handleIndex.value, (name) => name !== '');
  const productIds = uniqueStrings(productIndex.value, isHostedId);
  const [handleRecords, productRecords] = await Promise.all([
    kvMget(handles.map(handleKey)),
    kvMget(productIds.map(hostedProductKey)),
  ]);
  if (!handleRecords.ok || !productRecords.ok) return null;

  const uses = new Map<string, ImageUse[]>();
  const add = (raw: string | undefined, use: ImageUse) => {
    if (!raw) return;
    const key = imageUrlKey(raw);
    if (key === null) return;
    const list = uses.get(key) ?? [];
    // 同じ所 (同じ商品の追加画像に 2 回・同じ画像のリンクが 2 行) は 1 つにまとめる。
    if (!list.some((existing) => JSON.stringify(existing) === JSON.stringify(use))) list.push(use);
    uses.set(key, list);
  };

  handles.forEach((handle, index) => {
    const record = parseHandleRecord(handleRecords.value[index]);
    if (!record || record.owner.toLowerCase() !== owner) return;
    const profile = record.profile;
    add(profile?.avatar, { kind: 'profile', handle, field: 'avatar' });
    add(profile?.cover, { kind: 'profile', handle, field: 'cover' });
    for (const link of profile?.links ?? []) {
      if (link.kind !== 'heading') add(link.imageUrl, { kind: 'profile', handle, field: 'link' });
    }
    const storefront = record.storefront;
    add(storefront?.avatar, { kind: 'storefront', handle, field: 'avatar' });
    add(storefront?.cover, { kind: 'storefront', handle, field: 'cover' });
    for (const item of storefront?.menu ?? []) {
      if (item.visual?.kind === 'image') add(item.visual.url, { kind: 'storefront', handle, field: 'menu' });
    }
  });

  productIds.forEach((id, index) => {
    const product = parseStoredHostedProduct(productRecords.value[index]);
    if (!product || product.id !== id || product.owner.toLowerCase() !== owner) return;
    add(product.imageUrl, { kind: 'product', id, title: product.title, field: 'cover' });
    for (const url of product.galleryUrls ?? []) add(url, { kind: 'product', id, title: product.title, field: 'gallery' });
  });

  return {
    usesOf(url) {
      const key = imageUrlKey(url);
      return key === null ? [] : [...(uses.get(key) ?? [])];
    },
  };
}
