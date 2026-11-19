import 'server-only';

import { isAddress } from 'viem';
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
// 記録は 3 つに分ける (消してはいけない画像を「使っていない」と言わない向きにそろえる):
// - MGET の値が null (index にあるが記録が無い = 消えた記録): 使っていない。
// - 値があり、表示する側と同じ parser (parseHandleRecord・parseStoredHostedProduct) で読める: owner (と商品の id) を確かめ直し
//   (古い index が別のウォレットの記録を指していても、他人の記録を本人の使用先にしない)、本人の記録なら使用先を集める。
// - 値があるのに parser が読めない (壊れた記録・必須の項目の欠け): 使っているかが分からないので、読み取り全体を unreadable に
//   する (呼び元は 503・一覧も削除も止まる。記録を直すまで続く = 受け入れる限界)。
// 使用先は parser の結果ではなく、保存された JSON の決めた欄から集める。parser は店舗の部分 (受け付けていないチェーン・
// 壊れたメニュー) や不正な URL の欄を黙って落とすが、flag を戻す・直すとまた表示されるので、落とされた欄の画像も使用中に数える。
// 同じ pathname は別の host でも使用中と数える。store の違いで参照を見落とし、使用中の画像を消すのを防ぐ。
// 判定は読めた時点の記録まで: 読んだ後に公開した記録と、削除の del の間の競合は残る (受け入れる限界)。

export type ImageUsageIndex = {
  /** その Blob の pathname を使っている所 (無ければ空)。 */
  usesOf(pathname: string): ImageUse[];
};

export type ImageUsageResult =
  | { ok: true; usage: ImageUsageIndex }
  /** storage = KV が読めない・unreadable = 本人の index にある記録を parser が読めない。どちらも呼び元は 503。 */
  | { ok: false; reason: 'storage' | 'unreadable' };

/**
 * 記録の URL から pathname だけを取り出す (query と fragment も照合から外す)。表示する側 (lib/handle/record の parser 等) と
 * 同じく前後の空白 (全角の空白を含む) を trim してから読む: trim しないと末尾の空白が pathname に %E3%80%80 として残り、
 * 表示されている画像を「使用なし」と見て消せてしまう。
 */
function imageUrlPathname(raw: string): string | null {
  try {
    return new URL(raw.trim()).pathname;
  } catch {
    return null;
  }
}

function uniqueStrings(values: readonly string[], valid: (value: string) => boolean): string[] {
  return Array.from(new Set(values.filter(valid)));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * そのウォレットの記録を読んで、使っている所の索引を作る。KV が読めない・記録を読めないときは ok: false (呼び元は 503: 使って
 * いるかが分からないまま「使っていない」と言わない・消させない)。
 */
export function readImageUsage(wallet: string): Promise<ImageUsageResult> {
  // parser を含む収集処理が例外を投げたら、途中まで作った索引で未使用と判定して消さない。
  return collectImageUsage(wallet).catch(() => ({ ok: false, reason: 'unreadable' }));
}

async function collectImageUsage(wallet: string): Promise<ImageUsageResult> {
  const owner = wallet.toLowerCase();
  const [handleIndex, productIndex] = await Promise.all([
    kvLrange(ownerIndexKey(owner), 0, -1),
    kvLrange(hostedOwnerIndexKey(owner), 0, MAX_HOSTED_PER_OWNER - 1),
  ]);
  if (!handleIndex.ok || !productIndex.ok) return { ok: false, reason: 'storage' };
  const handles = uniqueStrings(handleIndex.value, (name) => name !== '');
  const productIds = uniqueStrings(productIndex.value, isHostedId);
  const [handleRecords, productRecords] = await Promise.all([
    kvMget(handles.map(handleKey)),
    kvMget(productIds.map(hostedProductKey)),
  ]);
  if (!handleRecords.ok || !productRecords.ok) return { ok: false, reason: 'storage' };

  const uses = new Map<string, ImageUse[]>();
  const add = (raw: unknown, use: ImageUse) => {
    if (typeof raw !== 'string' || raw === '') return;
    const key = imageUrlPathname(raw);
    if (key === null) return;
    const found = uses.get(key) ?? [];
    // 同じ所 (同じ商品の追加画像に 2 回・同じ画像のリンクが 2 行) は 1 つにまとめる。
    if (!found.some((existing) => JSON.stringify(existing) === JSON.stringify(use))) found.push(use);
    uses.set(key, found);
  };

  for (let index = 0; index < handles.length; index += 1) {
    const raw = handleRecords.value[index];
    if (raw === null) continue;
    const parsed = parseHandleRecord(raw);
    if (!parsed || !isAddress(parsed.owner, { strict: false })) return { ok: false, reason: 'unreadable' };
    if (parsed.owner.toLowerCase() !== owner) continue;
    const json = JSON.parse(raw) as Record<string, unknown>;
    const handle = handles[index];
    const profile = record(json.profile);
    add(profile?.avatar, { kind: 'profile', handle, field: 'avatar' });
    add(profile?.cover, { kind: 'profile', handle, field: 'cover' });
    for (const link of list(profile?.links)) add(record(link)?.imageUrl, { kind: 'profile', handle, field: 'link' });
    const storefront = record(json.storefront);
    add(storefront?.avatar, { kind: 'storefront', handle, field: 'avatar' });
    add(storefront?.cover, { kind: 'storefront', handle, field: 'cover' });
    for (const item of list(storefront?.menu)) {
      add(record(record(item)?.visual)?.url, { kind: 'storefront', handle, field: 'menu' });
    }
  }

  for (let index = 0; index < productIds.length; index += 1) {
    const raw = productRecords.value[index];
    if (raw === null) continue;
    const product = parseStoredHostedProduct(raw);
    if (!product) return { ok: false, reason: 'unreadable' };
    const id = productIds[index];
    if (product.id !== id || product.owner.toLowerCase() !== owner) continue;
    const json = JSON.parse(raw) as Record<string, unknown>;
    add(json.imageUrl, { kind: 'product', id, title: product.title, field: 'cover' });
    for (const url of list(json.galleryUrls)) add(text(url), { kind: 'product', id, title: product.title, field: 'gallery' });
  }

  return {
    ok: true,
    usage: {
      usesOf(pathname) {
        return uses.get(`/${pathname}`) ?? [];
      },
    },
  };
}
