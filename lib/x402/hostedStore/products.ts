import 'server-only';

// hosted creator products の product / content 操作 (R15a で lib/x402/hostedStore.ts から分割)。
// 作成・seller 置換・moderation 抹消は各 1 EVAL で原子化し、content revision は不変
// (編集 = 新 revision を追加・旧 revision は消さない)。Lua の bytes と KEYS/ARGV の順序は分割前と同一。
// ⚠️ 外からは '@/lib/x402/hostedStore' (facade) 経由で import する (vi.mock の対象を 1 つに保つ)。

import { isAddress } from 'viem';
import { licenseSellerAllowed, licenseVisible } from '@/lib/license/config';
import { createLicenseProduct } from '@/lib/license/product';
import { kvEval, kvGet, kvLrange, kvMget } from '@/lib/kv';
import {
  MAX_HOSTED_PER_OWNER,
  hostedContentKey,
  hostedOwnerIndexKey,
  hostedProductKey,
  isHostedId,
  isHttpsUrl,
  newHostedId,
  parseStoredHostedProduct,
  type HostedContent,
  type HostedProduct,
  type ParsedHostedInput,
} from './model';

// cap 判定 + product SET + content SET + owner index LPUSH を 1 EVAL で原子化する。
// (registry の CAS_CREATE と同型だが **global discovery index には触れない** — これが
//  external と混ざらないことの実装上の保証。)
// 戻り: 1=作成 / -2=cap 超過 / -3=id 衝突。
const CREATE_HOSTED =
  'local cap=tonumber(ARGV[4]); ' +
  "if redis.call('EXISTS',KEYS[1])==1 then return -3 end; " +
  "if redis.call('LLEN',KEYS[3])>=cap then return -2 end; " +
  "redis.call('SET',KEYS[1],ARGV[1]); " +
  "redis.call('SET',KEYS[2],ARGV[2]); " +
  "redis.call('LPUSH',KEYS[3],ARGV[3]); return 1";

export type CreateHostedResult =
  | { ok: true; product: HostedProduct }
  | { ok: false; reason: 'too_many' | 'conflict' | 'storage' };

export async function createHostedProduct(
  parsed: Extract<ParsedHostedInput, { ok: true }>,
  now = Date.now(),
): Promise<CreateHostedResult> {
  const id = newHostedId();
  const product: HostedProduct = { id, createdAt: now, ...parsed.product };
  if (product.productKind === 'license') return createLicenseProduct(product, parsed.content, parsed.licenseInput, MAX_HOSTED_PER_OWNER);
  const res = await kvEval<number>(
    CREATE_HOSTED,
    [
      hostedProductKey(id),
      hostedContentKey(id, product.contentRevision),
      hostedOwnerIndexKey(product.owner),
    ],
    [
      JSON.stringify(product),
      JSON.stringify(parsed.content),
      id,
      String(MAX_HOSTED_PER_OWNER),
    ],
  );
  if (!res.ok) return { ok: false, reason: 'storage' };
  if (res.value === -2) return { ok: false, reason: 'too_many' };
  if (res.value === -3) return { ok: false, reason: 'conflict' };
  return { ok: true, product };
}

export async function getHostedProduct(
  id: string,
): Promise<HostedProduct | null | 'storage'> {
  if (!isHostedId(id)) return null;
  const res = await kvGet(hostedProductKey(id));
  // KV 障害を「商品なし」に潰さない (呼び元は 503 に倒す・レビュー H-5)。
  if (!res.ok) return 'storage';
  if (res.value === null) return null;
  return parseStoredHostedProduct(res.value);
}

/**
 * seller 更新用の CAS snapshot。token は KV の生文字列で、API 応答には出さない。
 * 公開メタと秘密本文を同時更新するとき、読込後の並行更新を完全一致で検出する。
 */
export type HostedProductUpdateSnapshot = {
  product: HostedProduct;
  token: string;
};

export async function getHostedProductUpdateSnapshot(
  id: string,
): Promise<HostedProductUpdateSnapshot | null | 'storage'> {
  if (!isHostedId(id)) return null;
  const res = await kvGet(hostedProductKey(id));
  if (!res.ok) return 'storage';
  if (res.value === null) return null;
  const product = parseStoredHostedProduct(res.value);
  return product ? { product, token: res.value } : null;
}

export async function getHostedContent(
  id: string,
  revision: number,
): Promise<HostedContent | null | 'storage'> {
  if (!isHostedId(id) || !Number.isSafeInteger(revision) || revision < 1) {
    return null;
  }
  const res = await kvGet(hostedContentKey(id, revision));
  if (!res.ok) return 'storage';
  if (res.value === null) return null;
  try {
    const parsed = JSON.parse(res.value) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const r = parsed as Record<string, unknown>;
    if (r.kind !== 'url' && r.kind !== 'text') return null;
    if (typeof r.value !== 'string' || r.value.length === 0) return null;
    // 保存値は書込時に https 検証済みだが、読出でも再検証する (KV 改竄や旧レコードの
    // javascript:/data: が購入者ブラウザの遷移先に化けるのを、配信の直前で断つ。
    // imageUrl の読出再検証と同じ方針)。
    if (r.kind === 'url' && !isHttpsUrl(r.value)) return null;
    return { kind: r.kind, value: r.value };
  } catch {
    return null;
  }
}

export async function listHostedForOwner(
  wallet: string,
): Promise<HostedProduct[] | null> {
  if (!isAddress(wallet)) return null;
  const ids = await kvLrange(
    hostedOwnerIndexKey(wallet),
    0,
    MAX_HOSTED_PER_OWNER - 1,
  );
  if (!ids.ok) return null;
  const out: HostedProduct[] = [];
  for (const id of ids.value ?? []) {
    if (!isHostedId(id)) continue;
    const product = await getHostedProduct(id);
    if (product === 'storage') return null;
    if (product && licenseVisible(product) && product.owner.toLowerCase() === wallet.toLowerCase()) {
      out.push(product);
    }
  }
  return out;
}

/**
 * 公開プロフィール向けの販売可能商品 snapshot。owner index + MGET の 2 round-trip にし、
 * 公開ページへ最大 12 回の直列 REST GET を持ち込まない。本文 key は一切読まない。
 */
export async function listAvailableHostedForOwner(
  wallet: string,
): Promise<HostedProduct[] | null> {
  if (!isAddress(wallet)) return null;
  const ids = await kvLrange(
    hostedOwnerIndexKey(wallet),
    0,
    MAX_HOSTED_PER_OWNER - 1,
  );
  if (!ids.ok) return null;
  const validIds = (ids.value ?? []).filter(isHostedId);
  if (validIds.length === 0) return [];
  const values = await kvMget(validIds.map(hostedProductKey));
  if (
    !values.ok ||
    !Array.isArray(values.value) ||
    values.value.length !== validIds.length
  ) {
    return null;
  }
  const out: HostedProduct[] = [];
  for (let index = 0; index < validIds.length; index += 1) {
    const product = parseStoredHostedProduct(values.value[index]);
    if (
      product &&
      licenseVisible(product) &&
      (product.productKind !== 'license' || licenseSellerAllowed(product.owner)) &&
      product.id === validIds[index] &&
      product.owner.toLowerCase() === wallet.toLowerCase() &&
      product.saleActive &&
      product.contentAvailable
    ) {
      out.push(product);
    }
  }
  return out;
}

/**
 * Store 一覧 (P3) 用: index が返した id 列から公開可能な商品を引く。
 * **index はヒント・ここが権威**: parse 成功 + id 一致 + saleActive + contentAvailable
 * のみ通す (販売停止/moderation 抹消/壊れた行は表示に載らない)。順序は ids を保つ
 * (index の newest-first を尊重)。KV 障害は 'storage' (空と区別)。
 */
export async function getHostedProductsByIds(
  ids: readonly string[],
): Promise<HostedProduct[] | 'storage'> {
  const validIds = ids.filter(isHostedId);
  if (validIds.length === 0) return [];
  const values = await kvMget(validIds.map(hostedProductKey));
  if (
    !values.ok ||
    !Array.isArray(values.value) ||
    values.value.length !== validIds.length
  ) {
    return 'storage';
  }
  const out: HostedProduct[] = [];
  for (let index = 0; index < validIds.length; index += 1) {
    const product = parseStoredHostedProduct(values.value[index]);
    if (
      product &&
      licenseVisible(product) &&
      (product.productKind !== 'license' || licenseSellerAllowed(product.owner)) &&
      product.id === validIds[index] &&
      product.saleActive &&
      product.contentAvailable
    ) {
      out.push(product);
    }
  }
  return out;
}

/**
 * プロフィールに出す商品の選定 (厳選ショーケース・2026-08-04)。
 * featured が 1 つでもあれば featured のみ・無ければ全件 (既存商品は移行ゼロ)。
 * hidden は「Store には並ぶがプロフでは省いた」件数 (「すべての商品を見る」リンク用)。
 */
export function selectProfileProducts<T extends { featured?: boolean }>(
  products: readonly T[],
): { shown: T[]; hiddenCount: number } {
  const featured = products.filter((product) => product.featured === true);
  if (featured.length === 0) {
    return { shown: [...products], hiddenCount: 0 };
  }
  return { shown: featured, hiddenCount: products.length - featured.length };
}

// seller 管理画面の full edit を 1 EVAL で CAS 更新する。
// 戻り: 1=更新 / 0=なし / -1=owner 不一致 / -2=破損 / -4=並行更新。
// content が変わる場合も revision 本文 + 公開メタを同じ transaction で確定し、
// buyer が「新本文 + 旧価格」等の中間状態を観測できないようにする。
const REPLACE_HOSTED_SELLER_PRODUCT =
  "local cur=redis.call('GET',KEYS[1]); if not cur then return 0 end; " +
  'local ok,rec=pcall(cjson.decode,cur); if not ok then return -2 end; ' +
  "if type(rec.owner)~='string' or string.lower(rec.owner)~=ARGV[1] then return -1 end; " +
  'if cur~=ARGV[2] then return -4 end; ' +
  "if ARGV[3]=='1' then " +
  "if redis.call('EXISTS',KEYS[2])==1 then return -4 end; " +
  "redis.call('SET',KEYS[2],ARGV[4]); end; " +
  "redis.call('SET',KEYS[1],ARGV[5]); return 1";

export type ReplaceHostedSellerProductResult =
  | { ok: true; product: HostedProduct }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'forbidden'
        | 'corrupt'
        | 'conflict'
        | 'storage';
    };

/**
 * 出品フォームが管理するメタ (owner 限定の配布先を含む) を全置換し、必要なら新 content revision も原子的に
 * 追加する。旧 revision は残し、payTo / contentAvailable は seller から変更できない。
 */
export async function replaceHostedSellerProduct(input: {
  snapshot: HostedProductUpdateSnapshot;
  owner: string;
  metadata: Pick<
    HostedProduct,
    | 'title'
    | 'deliveryUrl'
    | 'imageUrl'
    | 'galleryUrls'
    | 'details'
    | 'specs'
    | 'demoUrl'
    | 'priceJpyc'
    | 'label'
    | 'category'
    | 'tags'
    | 'handle'
    | 'featured'
    | 'saleActive'
    | 'usdcEnabled'
  > & {
    desc?: string;
    emoji?: string;
  };
  content?: HostedContent;
  now?: number;
}): Promise<ReplaceHostedSellerProductResult> {
  const current = input.snapshot.product;
  if (
    !isAddress(input.owner) ||
    current.owner.toLowerCase() !== input.owner.toLowerCase()
  ) {
    return { ok: false, reason: 'forbidden' };
  }
  // 同じ tokenId に異なる経済条件/本文を混ぜず、登録前の販売開始も拒否する。
  if (current.productKind === 'license' && (!licenseVisible(current) || input.content || input.metadata.priceJpyc !== current.priceJpyc || input.metadata.usdcEnabled || (input.metadata.saleActive && (current.registration?.status !== 'registered' || !licenseSellerAllowed(current.owner))))) return { ok: false, reason: 'forbidden' };
  const revision = current.contentRevision + (input.content ? 1 : 0);
  const updatedAt = Math.max(
    input.now ?? Date.now(),
    (current.updatedAt ?? current.createdAt) + 1,
  );
  const next: HostedProduct = {
    id: current.id,
    ...(current.productKind === 'license' ? { productKind: current.productKind, license: current.license, registration: current.registration } : {}),
    owner: current.owner,
    payTo: current.payTo,
    title: input.metadata.title,
    ...(input.metadata.desc ? { desc: input.metadata.desc } : {}),
    ...(input.metadata.emoji ? { emoji: input.metadata.emoji } : {}),
    ...(input.metadata.deliveryUrl ? { deliveryUrl: input.metadata.deliveryUrl } : {}),
    ...(input.metadata.imageUrl ? { imageUrl: input.metadata.imageUrl } : {}),
    ...(input.metadata.galleryUrls?.length
      ? { galleryUrls: input.metadata.galleryUrls }
      : {}),
    ...(input.metadata.details ? { details: input.metadata.details } : {}),
    ...(input.metadata.specs?.length ? { specs: input.metadata.specs } : {}),
    ...(input.metadata.demoUrl ? { demoUrl: input.metadata.demoUrl } : {}),
    priceJpyc: input.metadata.priceJpyc,
    contentKind: input.content?.kind ?? current.contentKind,
    label: input.metadata.label,
    ...(input.metadata.category ? { category: input.metadata.category } : {}),
    ...(input.metadata.tags?.length ? { tags: input.metadata.tags } : {}),
    ...(input.metadata.handle ? { handle: input.metadata.handle } : {}),
    ...(input.metadata.featured === true ? { featured: true } : {}),
    ...(input.metadata.usdcEnabled === true ? { usdcEnabled: true } : {}),
    contentRevision: revision,
    saleActive: input.metadata.saleActive,
    contentAvailable: current.contentAvailable,
    createdAt: current.createdAt,
    updatedAt,
  };
  const res = await kvEval<number>(
    REPLACE_HOSTED_SELLER_PRODUCT,
    [
      hostedProductKey(current.id),
      hostedContentKey(current.id, revision),
    ],
    [
      current.owner.toLowerCase(),
      input.snapshot.token,
      input.content ? '1' : '0',
      input.content ? JSON.stringify(input.content) : '',
      JSON.stringify(next),
    ],
  );
  if (!res.ok) return { ok: false, reason: 'storage' };
  if (res.value === 0) return { ok: false, reason: 'not_found' };
  if (res.value === -1) return { ok: false, reason: 'forbidden' };
  if (res.value === -2) return { ok: false, reason: 'corrupt' };
  if (res.value === -4) return { ok: false, reason: 'conflict' };
  return { ok: true, product: next };
}

// Compare the raw snapshot before any deletion: a concurrent seller revision must not
// be orphaned by an operator writing stale metadata. Only content keys are deleted;
// ownership, purchase receipts, intents and indexes remain untouched.
const PURGE_HOSTED_CONTENT =
  "local cur=redis.call('GET',KEYS[1]); if not cur then return 0 end; " +
  'if cur~=ARGV[1] then return -4 end; ' +
  "for rev=1,tonumber(ARGV[3]) do redis.call('DEL',KEYS[1]..':content:'..rev); end; " +
  "redis.call('SET',KEYS[1],ARGV[2]); return 1";

export type PurgeHostedContentResult =
  | { ok: true; alreadyPurged: boolean; contentRevision: number }
  | { ok: false; reason: 'not_found' | 'corrupt' | 'conflict' | 'storage' };

/** Operator-only moderation. Atomically stop sales and purge all content revisions.
 * Keep the product record so existing buyers can receive the ended response.
 * Repeating a completed purge leaves the product (including updatedAt) unchanged.
 */
export async function purgeHostedContent(id: string): Promise<PurgeHostedContentResult> {
  if (!isHostedId(id)) return { ok: false, reason: 'not_found' };
  const stored = await kvGet(hostedProductKey(id));
  if (!stored.ok) return { ok: false, reason: 'storage' };
  if (stored.value === null) return { ok: false, reason: 'not_found' };
  const current = parseStoredHostedProduct(stored.value);
  // A corrupt embedded id must not redirect moderation to another seller's content.
  if (!current || current.id !== id) return { ok: false, reason: 'corrupt' };
  const alreadyPurged = !current.saleActive && !current.contentAvailable;
  const next = alreadyPurged ? stored.value : JSON.stringify({
    // Preserve fields outside the current parser's projection during moderation.
    ...JSON.parse(stored.value),
    saleActive: false,
    contentAvailable: false,
    updatedAt: Math.max(Date.now(), (current.updatedAt ?? current.createdAt) + 1),
  });
  const res = await kvEval<number>(
    PURGE_HOSTED_CONTENT,
    [hostedProductKey(id)],
    [stored.value, next, String(current.contentRevision)],
  );
  if (!res.ok) return { ok: false, reason: 'storage' };
  if (res.value === 0) return { ok: false, reason: 'not_found' };
  if (res.value === -4) return { ok: false, reason: 'conflict' };
  // An unexpected Redis result must not turn a failed purge into an operator success.
  if (res.value !== 1) return { ok: false, reason: 'storage' };
  return { ok: true, alreadyPurged, contentRevision: current.contentRevision };
}
