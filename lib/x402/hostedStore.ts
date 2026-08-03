import 'server-only';

// hosted creator products の KV ストア (クリエイター・ストア Phase 2)。
//
// ⚠️ **lib/x402/registry.ts (external resource) とは完全に別モジュール**。
// 理由 (計画レビュー H-3): registry の create は「global discovery index への LPUSH」を
// 常に行い、reverify cron は global index の全件を **external URL として probe** する。
// hosted を同じ index/parser に混ぜると、既存 external の discovery・cron・probeGate が
// 即座に影響を受ける。したがって index・key 空間・Lua・parser をすべて分離し、
// **registry.ts には 1 行も触れない**。
//
// key 空間 (external の `x402:resource:*` / `x402:resources:index` と衝突しない):
//   x402:hosted:<id>                        → HostedProduct (公開メタ・秘密を含まない)
//   x402:hosted:owner:<wallet>              → id の list (owner あたり cap)
//   x402:hosted:<id>:content:<revision>     → HostedContent (秘密本文・**不変**)
//
// 設計上の要点:
//   - saleActive と contentAvailable を分離 (レビュー H-5)。販売停止しても既購入者は取得可。
//     moderation の強制抹消のみ contentAvailable=false にする。
//   - content revision は不変。編集 = 新 revision を書いて公開メタを差し替える
//     (既購入者が指す revision が消えない)。
//   - payTo は feeReceiver / forwarder を**登録時に拒否** (レビュー H-2)。402 を出して
//     署名させた後に必ず失敗する構成を作らない。

import { getAddress, isAddress, type Address } from 'viem';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import {
  isHostedProductCategory,
  parseHostedTags,
  type HostedProductCategory,
} from '@/lib/x402/storeMeta';
import { kvDel, kvEval, kvGet, kvLrange, kvMget, kvSet } from '@/lib/kv';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';

/** owner (SIWE wallet) あたりの hosted 商品上限 (不正対策・2026-08-04 user 指示で 12→24)。 */
export const MAX_HOSTED_PER_OWNER = 24;
export const MAX_HOSTED_TITLE_LEN = 60;
export const MAX_HOSTED_DESC_LEN = 200;
export const MAX_HOSTED_URL_LEN = 512;
export const MAX_HOSTED_GALLERY_IMAGES = 4;
/** text 商品 (プロンプト / API キー / 手順) の上限 (Unicode code points)。 */
export const MAX_HOSTED_TEXT_CODE_POINTS = 20_000;
/** 価格の範囲 (human JPYC 整数)。 */
export const MIN_HOSTED_PRICE_JPYC = 1n;
export const MAX_HOSTED_PRICE_JPYC = 1_000_000n;

/** hosted id は prefix で external resource id と名前空間を分ける (レビュー L-1)。 */
const HOSTED_ID_PREFIX = 'h_';
const HOSTED_ID_RE = /^h_[0-9a-f]{32}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const UNSAFE_UNICODE_RE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** 表示ラベル (商品の見え方だけを変える。配信機構は kind が決める)。 */
export type HostedLabel =
  | 'download'
  | 'pdf'
  | 'zip'
  | 'prompt'
  | 'api'
  | 'external';

export type HostedContentKind = 'url' | 'text';

export type HostedProduct = {
  id: string;
  /** 出品者の SIWE wallet (checksum)。所有・編集権の主体。 */
  owner: Address;
  /** 売上の受取先 (checksum)。feeReceiver / forwarder は不可。 */
  payTo: Address;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  galleryUrls?: readonly string[];
  /** human JPYC 整数の文字列 (売り手受領額。買い手は別途 x402 手数料を上乗せ)。 */
  priceJpyc: string;
  contentKind: HostedContentKind;
  label: HostedLabel;
  /** Store カテゴリー (表示/検索専用・任意・購入 snapshot 非対象)。lib/x402/storeMeta。 */
  category?: HostedProductCategory;
  /** 検索/表示用タグ (表示専用・任意・購入 snapshot 非対象)。 */
  tags?: readonly string[];
  /** 掲載先 @handle (表示専用・任意・購入 snapshot 非対象)。未設定 = 旧仕様どおり
   * owner の全プロフに表示・Store 帰属は handles[0] (後方互換)。所有検証は API 層。 */
  handle?: string;
  /** プロフィールで優先表示 (表示専用)。同プロフの商品に 1 つでも true があれば
   * featured のみ表示・無ければ全表示 (selectProfileProducts・既存商品は移行ゼロ)。 */
  featured?: boolean;
  /** 現在配信する content の revision (1 始まり・編集で単調増加)。 */
  contentRevision: number;
  /** 新規購入を受け付けるか (販売停止しても既購入者の取得は続く)。 */
  saleActive: boolean;
  /** content を配信できるか。moderation 抹消時のみ false。 */
  contentAvailable: boolean;
  createdAt: number;
  updatedAt?: number;
};

export type HostedContent = {
  kind: HostedContentKind;
  /** kind==='url' は https URL・'text' は sanitize 済み本文。 */
  value: string;
};

export function hostedProductKey(id: string): string {
  return `x402:hosted:${id}`;
}
export function hostedOwnerIndexKey(wallet: string): string {
  return `x402:hosted:owner:${wallet.toLowerCase()}`;
}
export function hostedContentKey(id: string, revision: number): string {
  return `x402:hosted:${id}:content:${revision}`;
}

/** hosted id を採番する (prefix + 128bit hex)。 */
export function newHostedId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return (
    HOSTED_ID_PREFIX +
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  );
}

export function isHostedId(value: unknown): value is string {
  return typeof value === 'string' && HOSTED_ID_RE.test(value);
}

function isHttpsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

/**
 * text content の正規化。LF のみ保持し、制御 / 書式 / サロゲート (zero-width・bidi 含む) を除去。
 * lib/tipMessages.sanitizeTipMessage と同じ流儀 (上限だけ hosted 用)。
 * 上限超過は**切り捨てず undefined** (売り手の本文を黙って改変しない)。
 */
export function sanitizeHostedText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.replace(/\r\n?/g, '\n');
  const cleaned = [...normalized]
    .filter((ch) => ch === '\n' || !UNSAFE_UNICODE_RE.test(ch))
    .join('')
    .trim();
  const length = [...cleaned].length;
  if (length === 0 || length > MAX_HOSTED_TEXT_CODE_POINTS) return undefined;
  return cleaned;
}

function sanitizeLine(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = [...raw.replace(/[\r\n]+/g, ' ')]
    .filter((ch) => !UNSAFE_UNICODE_RE.test(ch))
    .join('')
    .trim();
  if (cleaned.length === 0 || cleaned.length > max) return undefined;
  return cleaned;
}

/** 絵文字は最大 2 code points (lib/handle の流儀)。不正は undefined で商品自体は残す。 */
function sanitizeEmoji(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const points = [...raw.trim()];
  if (points.length === 0 || points.length > 2) return undefined;
  if (points.some((ch) => UNSAFE_UNICODE_RE.test(ch))) return undefined;
  return points.join('');
}

const LABELS: readonly HostedLabel[] = [
  'download',
  'pdf',
  'zip',
  'prompt',
  'api',
  'external',
];

export function isHostedLabel(value: unknown): value is HostedLabel {
  return (
    typeof value === 'string' &&
    (LABELS as readonly string[]).includes(value)
  );
}

export type HostedProductInput = {
  owner: string;
  payTo?: string;
  title: unknown;
  desc?: unknown;
  emoji?: unknown;
  imageUrl?: unknown;
  galleryUrls?: unknown;
  priceJpyc: unknown;
  contentKind: unknown;
  label?: unknown;
  category?: unknown;
  tags?: unknown;
  handle?: unknown;
  featured?: unknown;
  content: unknown;
};

export type ParsedHostedInput =
  | { ok: true; product: Omit<HostedProduct, 'id' | 'createdAt'>; content: HostedContent }
  | { ok: false; error: string };

/**
 * 出品入力の検証 (server 権威)。**payTo が feeReceiver / forwarder なら拒否** —
 * forwarder の settle 検証は merchant==feeReceiver を拒否するため、これを許すと
 * 「402 を出して署名させた後に必ず失敗する商品」が作れてしまう (レビュー H-2)。
 */
export function parseHostedInput(input: HostedProductInput): ParsedHostedInput {
  if (!isAddress(input.owner)) return { ok: false, error: 'invalid owner' };
  const owner = getAddress(input.owner);

  const payToRaw = input.payTo ?? input.owner;
  if (typeof payToRaw !== 'string' || !isAddress(payToRaw)) {
    return { ok: false, error: 'invalid payTo' };
  }
  const payTo = getAddress(payToRaw);
  if (
    payTo.toLowerCase() === x402FacilitatorConfig.feeReceiver.toLowerCase()
  ) {
    return { ok: false, error: 'payTo must not be the fee receiver' };
  }
  const forwarder = configuredJpycForwarderFor(x402FacilitatorConfig.chainId);
  if (forwarder && payTo.toLowerCase() === forwarder.toLowerCase()) {
    return { ok: false, error: 'payTo must not be the forwarder' };
  }

  const title = sanitizeLine(input.title, MAX_HOSTED_TITLE_LEN);
  if (!title) return { ok: false, error: 'invalid title' };
  const desc =
    input.desc === undefined || input.desc === null
      ? undefined
      : sanitizeLine(input.desc, MAX_HOSTED_DESC_LEN);
  if (input.desc !== undefined && input.desc !== null && !desc) {
    return { ok: false, error: 'invalid desc' };
  }
  let imageUrl: string | undefined;
  if (
    input.imageUrl !== undefined &&
    input.imageUrl !== null &&
    input.imageUrl !== ''
  ) {
    if (typeof input.imageUrl !== 'string') {
      return { ok: false, error: 'invalid imageUrl' };
    }
    const candidate = input.imageUrl.trim();
    if (
      candidate &&
      (candidate.length > MAX_HOSTED_URL_LEN || !isHttpsUrl(candidate))
    ) {
      return { ok: false, error: 'invalid imageUrl' };
    }
    imageUrl = candidate || undefined;
  }
  let galleryUrls: string[] | undefined;
  if (input.galleryUrls !== undefined) {
    if (!Array.isArray(input.galleryUrls)) {
      return { ok: false, error: 'invalid gallery image' };
    }
    if (input.galleryUrls.length > MAX_HOSTED_GALLERY_IMAGES) {
      return { ok: false, error: 'too many gallery images' };
    }
    const candidates: string[] = [];
    for (const value of input.galleryUrls) {
      if (typeof value !== 'string') {
        return { ok: false, error: 'invalid gallery image' };
      }
      const candidate = value.trim();
      if (
        !candidate ||
        candidate.length > MAX_HOSTED_URL_LEN ||
        !isHttpsUrl(candidate)
      ) {
        return { ok: false, error: 'invalid gallery image' };
      }
      candidates.push(candidate);
    }
    galleryUrls = candidates.length > 0 ? candidates : undefined;
  }

  if (typeof input.priceJpyc !== 'string' || !DECIMAL_RE.test(input.priceJpyc)) {
    return { ok: false, error: 'invalid price' };
  }
  const price = BigInt(input.priceJpyc);
  if (price < MIN_HOSTED_PRICE_JPYC || price > MAX_HOSTED_PRICE_JPYC) {
    return { ok: false, error: 'price out of range' };
  }

  if (input.contentKind !== 'url' && input.contentKind !== 'text') {
    return { ok: false, error: 'invalid contentKind' };
  }
  const contentKind: HostedContentKind = input.contentKind;

  const label: HostedLabel =
    typeof input.label === 'string' &&
    (LABELS as readonly string[]).includes(input.label)
      ? (input.label as HostedLabel)
      : contentKind === 'url'
        ? 'download'
        : 'prompt';

  // category / tags は表示・検索専用 (購入 snapshot 非対象・掟 12/15)。
  if (input.category !== undefined && input.category !== null && input.category !== '') {
    if (!isHostedProductCategory(input.category)) {
      return { ok: false, error: 'invalid category' };
    }
  }
  const category: HostedProductCategory | undefined =
    isHostedProductCategory(input.category) ? input.category : undefined;
  const parsedTags = parseHostedTags(input.tags);
  if (!parsedTags.ok) return { ok: false, error: parsedTags.error };
  // 掲載先 handle: 形式のみここで検証 (所有検証は KV を伴うため API 層の責務)。
  let listingHandle: string | undefined;
  if (
    input.handle !== undefined &&
    input.handle !== null &&
    input.handle !== ''
  ) {
    if (typeof input.handle !== 'string') {
      return { ok: false, error: 'invalid handle' };
    }
    const normalized = normalizeHandle(input.handle);
    if (!isValidHandleFormat(normalized)) {
      return { ok: false, error: 'invalid handle' };
    }
    listingHandle = normalized;
  }
  if (input.featured !== undefined && typeof input.featured !== 'boolean') {
    return { ok: false, error: 'invalid featured' };
  }

  let content: HostedContent;
  if (contentKind === 'url') {
    if (
      typeof input.content !== 'string' ||
      input.content.length > MAX_HOSTED_URL_LEN ||
      !isHttpsUrl(input.content.trim())
    ) {
      return { ok: false, error: 'content url must be https' };
    }
    content = { kind: 'url', value: input.content.trim() };
  } else {
    const text = sanitizeHostedText(input.content);
    if (!text) return { ok: false, error: 'invalid content text' };
    content = { kind: 'text', value: text };
  }

  return {
    ok: true,
    product: {
      owner,
      payTo,
      title,
      ...(desc ? { desc } : {}),
      ...(sanitizeEmoji(input.emoji) ? { emoji: sanitizeEmoji(input.emoji) } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(galleryUrls ? { galleryUrls } : {}),
      priceJpyc: price.toString(),
      contentKind,
      label,
      ...(category ? { category } : {}),
      ...(parsedTags.tags ? { tags: parsedTags.tags } : {}),
      ...(listingHandle ? { handle: listingHandle } : {}),
      ...(input.featured === true ? { featured: true } : {}),
      contentRevision: 1,
      saleActive: true,
      contentAvailable: true,
    },
    content,
  };
}

/** KV は untrusted。読込時も検証し、壊れた行は null (呼び元が個別に落とす)。 */
export function parseStoredHostedProduct(raw: unknown): HostedProduct | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (!isHostedId(r.id)) return null;
  if (typeof r.owner !== 'string' || !isAddress(r.owner)) return null;
  if (typeof r.payTo !== 'string' || !isAddress(r.payTo)) return null;
  const title = sanitizeLine(r.title, MAX_HOSTED_TITLE_LEN);
  if (!title) return null;
  if (typeof r.priceJpyc !== 'string' || !DECIMAL_RE.test(r.priceJpyc)) return null;
  if (r.contentKind !== 'url' && r.contentKind !== 'text') return null;
  if (
    typeof r.contentRevision !== 'number' ||
    !Number.isSafeInteger(r.contentRevision) ||
    r.contentRevision < 1
  ) {
    return null;
  }
  if (typeof r.createdAt !== 'number' || !Number.isSafeInteger(r.createdAt)) {
    return null;
  }
  const label: HostedLabel =
    typeof r.label === 'string' && (LABELS as readonly string[]).includes(r.label)
      ? (r.label as HostedLabel)
      : 'download';
  const desc = sanitizeLine(r.desc, MAX_HOSTED_DESC_LEN);
  const emoji = sanitizeEmoji(r.emoji);
  const imageUrlCandidate =
    typeof r.imageUrl === 'string' ? r.imageUrl.trim() : undefined;
  const imageUrl =
    imageUrlCandidate &&
    imageUrlCandidate.length <= MAX_HOSTED_URL_LEN &&
    isHttpsUrl(imageUrlCandidate)
      ? imageUrlCandidate
      : undefined;
  const galleryUrls: string[] = [];
  if (Array.isArray(r.galleryUrls)) {
    for (const value of r.galleryUrls) {
      if (galleryUrls.length >= MAX_HOSTED_GALLERY_IMAGES) break;
      if (typeof value !== 'string') continue;
      const candidate = value.trim();
      if (
        !candidate ||
        candidate.length > MAX_HOSTED_URL_LEN ||
        !isHttpsUrl(candidate)
      ) {
        continue;
      }
      galleryUrls.push(candidate);
    }
  }
  // category/tags: 不正値は落として商品自体は残す (emoji と同じ寛容読込)。
  const category = isHostedProductCategory(r.category) ? r.category : undefined;
  const storedTags = parseHostedTags(r.tags);
  const tags = storedTags.ok ? storedTags.tags : undefined;
  const storedHandle =
    typeof r.handle === 'string' && isValidHandleFormat(normalizeHandle(r.handle))
      ? normalizeHandle(r.handle)
      : undefined;
  return {
    id: r.id,
    owner: getAddress(r.owner),
    payTo: getAddress(r.payTo),
    title,
    ...(desc ? { desc } : {}),
    ...(emoji ? { emoji } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(galleryUrls.length > 0 ? { galleryUrls } : {}),
    priceJpyc: r.priceJpyc,
    contentKind: r.contentKind,
    label,
    ...(category ? { category } : {}),
    ...(tags ? { tags } : {}),
    ...(storedHandle ? { handle: storedHandle } : {}),
    ...(r.featured === true ? { featured: true } : {}),
    contentRevision: r.contentRevision,
    // 旧レコードや壊れた値は「販売停止・配信可」に倒す (誤って売らない側へ)。
    saleActive: r.saleActive === true,
    contentAvailable: r.contentAvailable !== false,
    createdAt: r.createdAt,
    ...(typeof r.updatedAt === 'number' && Number.isSafeInteger(r.updatedAt)
      ? { updatedAt: r.updatedAt }
      : {}),
  };
}

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
    if (product && product.owner.toLowerCase() === wallet.toLowerCase()) {
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

// owner 確認 + 公開メタ更新を原子化 (CAS)。owner 不一致は -1 で拒否。
// content は差し替えない (編集は新 revision を書く別操作)。
const UPDATE_HOSTED =
  "local cur=redis.call('GET',KEYS[1]); if not cur then return 0 end; " +
  'local ok,rec=pcall(cjson.decode,cur); if not ok then return -2 end; ' +
  'if string.lower(rec.owner)~=ARGV[1] then return -1 end; ' +
  "redis.call('SET',KEYS[1],ARGV[2]); return 1";

export type UpdateHostedResult =
  | { ok: true; product: HostedProduct }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'corrupt' | 'storage' };

/**
 * 公開メタの更新 (owner 限定)。saleActive の切替と title/desc/emoji/price の変更に使う。
 * **contentAvailable は運営のみが下げる**ため、ここでは受け付けない。
 */
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

export async function updateHostedProduct(input: {
  id: string;
  owner: string;
  patch: Partial<
    Pick<HostedProduct, 'title' | 'desc' | 'emoji' | 'priceJpyc' | 'saleActive'>
  >;
  now?: number;
}): Promise<UpdateHostedResult> {
  const current = await getHostedProduct(input.id);
  if (current === 'storage') return { ok: false, reason: 'storage' };
  if (!current) return { ok: false, reason: 'not_found' };
  if (
    !isAddress(input.owner) ||
    current.owner.toLowerCase() !== input.owner.toLowerCase()
  ) {
    return { ok: false, reason: 'forbidden' };
  }
  const next: HostedProduct = {
    ...current,
    ...(input.patch.title !== undefined
      ? { title: input.patch.title }
      : {}),
    ...(input.patch.desc !== undefined ? { desc: input.patch.desc } : {}),
    ...(input.patch.emoji !== undefined ? { emoji: input.patch.emoji } : {}),
    ...(input.patch.priceJpyc !== undefined
      ? { priceJpyc: input.patch.priceJpyc }
      : {}),
    ...(input.patch.saleActive !== undefined
      ? { saleActive: input.patch.saleActive }
      : {}),
    updatedAt: input.now ?? Date.now(),
  };
  const res = await kvEval<number>(
    UPDATE_HOSTED,
    [hostedProductKey(current.id)],
    [current.owner.toLowerCase(), JSON.stringify(next)],
  );
  if (!res.ok) return { ok: false, reason: 'storage' };
  if (res.value === 0) return { ok: false, reason: 'not_found' };
  if (res.value === -1) return { ok: false, reason: 'forbidden' };
  if (res.value === -2) return { ok: false, reason: 'corrupt' };
  return { ok: true, product: next };
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
 * 出品フォームが管理する公開メタを全置換し、必要なら新 content revision も原子的に
 * 追加する。旧 revision は残し、payTo / contentAvailable は seller から変更できない。
 */
export async function replaceHostedSellerProduct(input: {
  snapshot: HostedProductUpdateSnapshot;
  owner: string;
  metadata: Pick<
    HostedProduct,
    | 'title'
    | 'imageUrl'
    | 'galleryUrls'
    | 'priceJpyc'
    | 'label'
    | 'category'
    | 'tags'
    | 'handle'
    | 'featured'
    | 'saleActive'
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
  const revision = current.contentRevision + (input.content ? 1 : 0);
  const updatedAt = Math.max(
    input.now ?? Date.now(),
    (current.updatedAt ?? current.createdAt) + 1,
  );
  const next: HostedProduct = {
    id: current.id,
    owner: current.owner,
    payTo: current.payTo,
    title: input.metadata.title,
    ...(input.metadata.desc ? { desc: input.metadata.desc } : {}),
    ...(input.metadata.emoji ? { emoji: input.metadata.emoji } : {}),
    ...(input.metadata.imageUrl ? { imageUrl: input.metadata.imageUrl } : {}),
    ...(input.metadata.galleryUrls?.length
      ? { galleryUrls: input.metadata.galleryUrls }
      : {}),
    priceJpyc: input.metadata.priceJpyc,
    contentKind: input.content?.kind ?? current.contentKind,
    label: input.metadata.label,
    ...(input.metadata.category ? { category: input.metadata.category } : {}),
    ...(input.metadata.tags?.length ? { tags: input.metadata.tags } : {}),
    ...(input.metadata.handle ? { handle: input.metadata.handle } : {}),
    ...(input.metadata.featured === true ? { featured: true } : {}),
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

/**
 * content を新 revision で差し替える。**旧 revision は削除しない** —
 * 既購入者が指す revision が消えると恒久 entitlement が無意味になる (レビュー H-5/G)。
 */
export async function putHostedContentRevision(input: {
  id: string;
  owner: string;
  content: HostedContent;
  now?: number;
}): Promise<UpdateHostedResult> {
  const current = await getHostedProduct(input.id);
  if (current === 'storage') return { ok: false, reason: 'storage' };
  if (!current) return { ok: false, reason: 'not_found' };
  if (
    !isAddress(input.owner) ||
    current.owner.toLowerCase() !== input.owner.toLowerCase()
  ) {
    return { ok: false, reason: 'forbidden' };
  }
  const revision = current.contentRevision + 1;
  const written = await kvSet(
    hostedContentKey(current.id, revision),
    JSON.stringify(input.content),
  );
  if (!written.ok) return { ok: false, reason: 'storage' };
  // content を先に書いてから公開メタを進める = 「メタは新 revision を指すが本文が無い」
  // 孤児を作らない (順序が防御・レビュー H-1)。
  const next: HostedProduct = {
    ...current,
    contentKind: input.content.kind,
    contentRevision: revision,
    updatedAt: input.now ?? Date.now(),
  };
  const res = await kvEval<number>(
    UPDATE_HOSTED,
    [hostedProductKey(current.id)],
    [current.owner.toLowerCase(), JSON.stringify(next)],
  );
  if (!res.ok) return { ok: false, reason: 'storage' };
  if (res.value === 0) return { ok: false, reason: 'not_found' };
  if (res.value === -1) return { ok: false, reason: 'forbidden' };
  if (res.value === -2) return { ok: false, reason: 'corrupt' };
  return { ok: true, product: next };
}

/**
 * 運営専用の強制抹消 (moderation)。`contentAvailable=false` にし、全 revision の本文を消す。
 * **商品レコードと owner index は残す** (購入者に「提供終了」を返すため・黙って 404 にしない)。
 */
export async function purgeHostedContent(id: string): Promise<boolean> {
  const current = await getHostedProduct(id);
  if (current === 'storage' || !current) return false;
  for (let rev = 1; rev <= current.contentRevision; rev += 1) {
    await kvDel(hostedContentKey(current.id, rev));
  }
  const next: HostedProduct = {
    ...current,
    saleActive: false,
    contentAvailable: false,
    updatedAt: Date.now(),
  };
  const res = await kvSet(hostedProductKey(current.id), JSON.stringify(next));
  return res.ok;
}

// ---------------------------------------------------------------------------
// 出品者の販売者情報 (特商法対応・Terms 第 13 条 (4))
//
// 反復継続の営利販売を行う出品者は特商法上の販売業者になり得る。表示義務は出品者が
// 負うため、OpenPay は「購入画面から参照できる販売者情報」の置き場と、**未登録なら
// 販売開始できない**という enforce の口を提供する (真偽の検証はしない・できない)。
// 保存先: x402:hosted:seller:<wallet>
// ---------------------------------------------------------------------------

export const MAX_SELLER_NAME_LEN = 60;
export const MAX_SELLER_CONTACT_LEN = 200;
export const MAX_SELLER_DISCLOSURE_LEN = 1000;

export type SellerDisclosure = {
  /** 氏名または名称 (必須)。 */
  name: string;
  /** 連絡先 (必須・メールアドレス等)。購入者からの連絡手段 (Terms 13 条 (7) の協力の実体)。 */
  contact: string;
  /**
   * 法定表示の自由記載 (任意)。販売業者に該当する出品者が住所・電話番号等の
   * 特商法上の必要事項を記載する欄。改行可。
   */
  disclosure?: string;
  updatedAt: number;
};

export function sellerDisclosureKey(wallet: string): string {
  return `x402:hosted:seller:${wallet.toLowerCase()}`;
}

export type ParsedSellerDisclosure =
  | { ok: true; value: Omit<SellerDisclosure, 'updatedAt'> }
  | { ok: false; error: string };

export function parseSellerDisclosureInput(input: {
  name: unknown;
  contact: unknown;
  disclosure?: unknown;
}): ParsedSellerDisclosure {
  const name = sanitizeLine(input.name, MAX_SELLER_NAME_LEN);
  if (!name) return { ok: false, error: 'invalid name' };
  const contact = sanitizeLine(input.contact, MAX_SELLER_CONTACT_LEN);
  if (!contact) return { ok: false, error: 'invalid contact' };
  let disclosure: string | undefined;
  if (input.disclosure !== undefined && input.disclosure !== null) {
    if (typeof input.disclosure !== 'string') {
      return { ok: false, error: 'invalid disclosure' };
    }
    const cleaned = [...input.disclosure.replace(/\r\n?/g, '\n')]
      .filter((ch) => ch === '\n' || !UNSAFE_UNICODE_RE.test(ch))
      .join('')
      .trim();
    const len = [...cleaned].length;
    if (len > MAX_SELLER_DISCLOSURE_LEN) {
      return { ok: false, error: 'disclosure too long' };
    }
    if (len > 0) disclosure = cleaned;
  }
  return { ok: true, value: { name, contact, ...(disclosure ? { disclosure } : {}) } };
}

export async function putSellerDisclosure(
  wallet: string,
  value: Omit<SellerDisclosure, 'updatedAt'>,
  now = Date.now(),
): Promise<boolean> {
  if (!isAddress(wallet)) return false;
  const record: SellerDisclosure = { ...value, updatedAt: now };
  const res = await kvSet(sellerDisclosureKey(wallet), JSON.stringify(record));
  return res.ok;
}

export async function getSellerDisclosure(
  wallet: string,
): Promise<SellerDisclosure | null | 'storage'> {
  if (!isAddress(wallet)) return null;
  const res = await kvGet(sellerDisclosureKey(wallet));
  if (!res.ok) return 'storage';
  if (res.value === null) return null;
  try {
    const raw = JSON.parse(res.value) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const name = sanitizeLine(r.name, MAX_SELLER_NAME_LEN);
    const contact = sanitizeLine(r.contact, MAX_SELLER_CONTACT_LEN);
    if (!name || !contact) return null;
    if (
      typeof r.updatedAt !== 'number' ||
      !Number.isSafeInteger(r.updatedAt)
    ) {
      return null;
    }
    return {
      name,
      contact,
      ...(typeof r.disclosure === 'string' && r.disclosure.trim()
        ? { disclosure: r.disclosure }
        : {}),
      updatedAt: r.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * 販売開始 (saleActive=true) の前提条件。**API 層 (trust boundary) がこれを enforce する**
 * 契約: 未登録 (null) なら販売開始を拒否し、'storage' なら 503 に倒す (黙って許可しない)。
 */
export async function sellerDisclosureComplete(
  wallet: string,
): Promise<boolean | 'storage'> {
  const d = await getSellerDisclosure(wallet);
  if (d === 'storage') return 'storage';
  return d !== null;
}

/**
 * 購入時点の表示メタ snapshot。content 本文は含めず、不変 revision の参照だけを
 * PurchaseIntent / ownership 側に保存する (creator-store v4 契約 C/G)。
 */
export type HostedPurchaseMetadata = Pick<
  HostedProduct,
  | 'owner'
  | 'payTo'
  | 'title'
  | 'desc'
  | 'emoji'
  | 'priceJpyc'
  | 'contentKind'
  | 'label'
>;

export function hostedPurchaseMetadata(
  product: HostedProduct,
): HostedPurchaseMetadata {
  return {
    owner: product.owner,
    payTo: product.payTo,
    title: product.title,
    ...(product.desc === undefined ? {} : { desc: product.desc }),
    ...(product.emoji === undefined ? {} : { emoji: product.emoji }),
    priceJpyc: product.priceJpyc,
    contentKind: product.contentKind,
    label: product.label,
  };
}
