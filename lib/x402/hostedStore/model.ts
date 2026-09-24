import 'server-only';

// hosted creator products の model / parsing (R15a で lib/x402/hostedStore.ts から分割)。
// key 空間・保存 record の型・出品入力の検証 (parseHostedInput)・KV 読込時の再検証
// (parseStoredHostedProduct)・購入 snapshot の射影を持つ。KV の I/O はしない。
// ⚠️ 外からは '@/lib/x402/hostedStore' (facade) 経由で import する (vi.mock の対象を 1 つに保つ)。
// 宣言の本文は分割前と byte 一致 (保存 JSON のプロパティ順も不変)。

import { getAddress, isAddress, type Address } from 'viem';
import { LABELS, type HostedLabel } from '@/lib/x402/storeWire';
import { parseDeliveryUrl } from '@/lib/store/deliveryUrl';
import { LICENSE_DEFAULT_INSTRUCTIONS, parseLicenseDefinition, parseLicenseRegistration, parseLicenseCreationTerms, type LicenseDefinition, type LicenseRegistration, type LicenseTermsInput } from '@/lib/license/definition';
import { licenseDeployment, licenseSellerAllowed } from '@/lib/license/config';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import {
  isHostedProductCategory,
  parseHostedTags,
  type HostedProductCategory,
} from '@/lib/x402/storeMeta';
import { x402FacilitatorConfig } from '@/lib/x402/facilitatorConfig';
import { configuredJpycForwarderFor } from '@/lib/relay/forwarderConfig';

/** owner (SIWE wallet) あたりの hosted 商品上限 (不正対策・2026-08-04 user 指示で 12→24)。 */
export const MAX_HOSTED_PER_OWNER = 24;
export const MAX_HOSTED_TITLE_LEN = 60;
export const MAX_HOSTED_DESC_LEN = 200;
export const MAX_HOSTED_URL_LEN = 512;
export const MAX_HOSTED_GALLERY_IMAGES = 4;
export const MAX_HOSTED_DETAILS_LEN = 2000;
export const MAX_HOSTED_SPECS = 8;
export const MAX_HOSTED_SPEC_LABEL_LEN = 24;
export const MAX_HOSTED_SPEC_VALUE_LEN = 80;
/** text 商品 (プロンプト / API キー / 手順) の上限 (Unicode code points)。 */
export const MAX_HOSTED_TEXT_CODE_POINTS = 20_000;
/** 価格の範囲 (human JPYC 整数)。 */
export const MIN_HOSTED_PRICE_JPYC = 1n;
export const MAX_HOSTED_PRICE_JPYC = 1_000_000n;

/** hosted id は prefix で external resource id と名前空間を分ける (レビュー L-1)。 */
const HOSTED_ID_PREFIX = 'h_';
const HOSTED_ID_RE = /^h_[0-9a-f]{32}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
export const UNSAFE_UNICODE_RE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export type HostedContentKind = 'url' | 'text';

export type HostedProduct = {
  productKind?: 'license';
  license?: LicenseDefinition;
  registration?: LicenseRegistration;
  id: string;
  /** 出品者の SIWE wallet (checksum)。所有・編集権の主体。 */
  owner: Address;
  /** 売上の受取先 (checksum)。feeReceiver / forwarder は不可。 */
  payTo: Address;
  title: string;
  desc?: string;
  emoji?: string;
  imageUrl?: string;
  /** owner 限定の配布先。購入 snapshot 非対象・公開時は protectedDelivery boolean のみ。 */
  deliveryUrl?: string;
  galleryUrls?: readonly string[];
  /** 表示専用の詳細情報 (購入 snapshot 非対象)。 */
  details?: string;
  specs?: readonly { label: string; value: string }[];
  demoUrl?: string;
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
  /** Base native USDC rail を明示的に提供する。保存値 true だけが ON。 */
  usdcEnabled?: true;
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

export function isHttpsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

/** imageUrl / demoUrl 共通。空欄は ''、不正値は undefined。 */
function parseOptionalDisplayUrl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return undefined;
  const candidate = raw.trim();
  if (candidate && (candidate.length > MAX_HOSTED_URL_LEN || !isHttpsUrl(candidate))) return undefined;
  return candidate;
}

function parseDetails(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return undefined;
  // 改行は同ファイルの他の複数行入力と同じ規則で正規化 (単独 CR も改行)。3 連続以上の改行は 2 つに畳む —
  // 上限内の「改行だけ 2,000 行」で購入モーダルが縦に伸びる表示破綻を断つ。
  const cleaned = [...raw.replace(/\r\n?/g, '\n')]
    .filter((ch) => ch === '\n' || !UNSAFE_UNICODE_RE.test(ch))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return [...cleaned].length <= MAX_HOSTED_DETAILS_LEN ? cleaned : undefined;
}

function parseSpec(raw: unknown): { label: string; value: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.label !== 'string' || typeof row.value !== 'string') return undefined;
  const clean = (text: string) => [...text].filter((ch) => !UNSAFE_UNICODE_RE.test(ch)).join('').trim();
  const label = clean(row.label);
  const value = clean(row.value);
  // ラベルにコロンを許さない: 出品フォームは「ラベル: 値」の 1 行テキストで編集するため、コロン入りラベルは
  // 編集 → 保存の往復で「Ratio 16:9」が「Ratio 16 / 9: …」に化ける (黙った改変)。値側のコロンは可。
  if (/[:：]/.test(label)) return undefined;
  if (!label || !value || [...label].length > MAX_HOSTED_SPEC_LABEL_LEN || [...value].length > MAX_HOSTED_SPEC_VALUE_LEN) return undefined;
  return { label, value };
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

export function sanitizeLine(raw: unknown, max: number): string | undefined {
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

export type HostedProductInput = {
  productKind?: unknown;
  license?: unknown;
  owner: string;
  payTo?: string;
  title: unknown;
  desc?: unknown;
  emoji?: unknown;
  imageUrl?: unknown;
  deliveryUrl?: unknown;
  galleryUrls?: unknown;
  details?: unknown;
  specs?: unknown;
  demoUrl?: unknown;
  priceJpyc: unknown;
  contentKind: unknown;
  label?: unknown;
  category?: unknown;
  tags?: unknown;
  handle?: unknown;
  featured?: unknown;
  usdcEnabled?: unknown;
  content: unknown;
};

export type ParsedHostedInput =
  | { ok: true; product: Omit<HostedProduct, 'id' | 'createdAt'>; content: HostedContent; licenseInput?: LicenseTermsInput }
  | { ok: false; error: string };

/**
 * 出品入力の検証 (server 権威)。**payTo が feeReceiver / forwarder なら拒否** —
 * forwarder の settle 検証は merchant==feeReceiver を拒否するため、これを許すと
 * 「402 を出して署名させた後に必ず失敗する商品」が作れてしまう (レビュー H-2)。
 */
export function parseHostedInput(input: HostedProductInput): ParsedHostedInput {
  if (!isAddress(input.owner)) return { ok: false, error: 'invalid owner' };
  const owner = getAddress(input.owner);
  if (input.productKind !== undefined && input.productKind !== 'license') return { ok: false, error: 'invalid productKind' };
  const isLicense = input.productKind === 'license';
  const licenseInput = isLicense ? parseLicenseCreationTerms(input.license) : null;
  if (isLicense && (!licenseSellerAllowed(owner) || !licenseDeployment())) return { ok: false, error: 'license_unavailable' };
  if (isLicense && (!licenseInput || Object.keys(input.license as object).some((key) => !['supply', 'transferable', 'termsUrl', 'termsVersion', 'termsPreset'].includes(key)))) return { ok: false, error: 'invalid license' };
  if (!isLicense && input.license !== undefined) return { ok: false, error: 'invalid license' };
  if (isLicense && (input.contentKind !== 'text' || input.usdcEnabled === true)) return { ok: false, error: 'license_jpyc_text_only' };

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
  const imageUrl = parseOptionalDisplayUrl(input.imageUrl);
  if (imageUrl === undefined) return { ok: false, error: 'invalid imageUrl' };
  let deliveryUrl: string | undefined;
  if (input.deliveryUrl !== undefined && input.deliveryUrl !== null && input.deliveryUrl !== '') {
    const parsed = parseDeliveryUrl(input.deliveryUrl);
    if (!parsed.ok) return { ok: false, error: 'invalid deliveryUrl' };
    deliveryUrl = parsed.url;
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

  const details = parseDetails(input.details);
  if (details === undefined) return { ok: false, error: 'invalid details' };
  const specs: { label: string; value: string }[] = [];
  if (input.specs !== undefined && input.specs !== null) {
    if (!Array.isArray(input.specs) || input.specs.length > MAX_HOSTED_SPECS) {
      return { ok: false, error: 'invalid specs' };
    }
    for (const raw of input.specs) {
      const row = parseSpec(raw);
      if (!row) return { ok: false, error: 'invalid specs' };
      specs.push(row);
    }
  }
  const demoUrl = parseOptionalDisplayUrl(input.demoUrl);
  if (demoUrl === undefined) return { ok: false, error: 'invalid demoUrl' };

  if (typeof input.priceJpyc !== 'string' || !DECIMAL_RE.test(input.priceJpyc)) {
    return { ok: false, error: 'invalid price' };
  }
  const price = BigInt(input.priceJpyc);
  if (isLicense && price < 1000n) return { ok: false, error: 'license_price_minimum' };
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
  if (
    input.usdcEnabled !== undefined &&
    typeof input.usdcEnabled !== 'boolean'
  ) {
    return { ok: false, error: 'invalid usdcEnabled' };
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
    // license の空欄だけ定型案内へ。通常デジタル text の空欄拒否には波及させない。
    const text = sanitizeHostedText(isLicense && (input.content === undefined || (typeof input.content === 'string' && input.content.trim() === '')) ? LICENSE_DEFAULT_INSTRUCTIONS : input.content);
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
      ...(deliveryUrl ? { deliveryUrl } : {}),
      ...(galleryUrls ? { galleryUrls } : {}),
      ...(details ? { details } : {}),
      ...(specs.length ? { specs } : {}),
      ...(demoUrl ? { demoUrl } : {}),
      priceJpyc: price.toString(),
      contentKind,
      label,
      ...(category ? { category } : {}),
      ...(parsedTags.tags ? { tags: parsedTags.tags } : {}),
      ...(listingHandle ? { handle: listingHandle } : {}),
      ...(input.featured === true ? { featured: true } : {}),
      ...(input.usdcEnabled === true ? { usdcEnabled: true } : {}),
      contentRevision: 1,
      ...(isLicense ? { productKind: 'license' as const, registration: { status: 'pending' as const, attempts: 0 } } : {}),
      saleActive: !isLicense,
      contentAvailable: true,
    },
    content,
    ...(licenseInput ? { licenseInput } : {}),
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
  if (r.productKind !== undefined && r.productKind !== 'license') return null;
  const license = r.productKind === 'license' ? parseLicenseDefinition(r.license) : null;
  const registration = r.productKind === 'license' ? parseLicenseRegistration(r.registration) : null;
  if (r.productKind === 'license' && (!license || !registration || license.contentRef !== hostedContentKey(r.id, 1) || r.contentRevision !== 1 || r.contentKind !== 'text' || r.usdcEnabled === true || typeof r.priceJpyc !== 'string' || !DECIMAL_RE.test(r.priceJpyc) || BigInt(r.priceJpyc) < 1000n || BigInt(r.priceJpyc) > MAX_HOSTED_PRICE_JPYC || (r.saleActive === true && registration.status !== 'registered'))) return null;
  if (r.productKind === undefined && (r.license !== undefined || r.registration !== undefined)) return null;
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
  const imageUrl = parseOptionalDisplayUrl(r.imageUrl);
  // 掟 13: 補助機能の破損を決済/content 経路へ波及させない。無効な保存 URL だけ落とす。
  const deliveryUrl = parseDeliveryUrl(r.deliveryUrl);
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
  // 表示メタの破損を商品・購入経路に波及させない。仕様も gallery と同様に不正な行だけ落とす。
  const details = parseDetails(r.details);
  const demoUrl = parseOptionalDisplayUrl(r.demoUrl);
  const specs: { label: string; value: string }[] = [];
  if (Array.isArray(r.specs)) {
    for (const raw of r.specs) {
      if (specs.length >= MAX_HOSTED_SPECS) break;
      const row = parseSpec(raw);
      if (row) specs.push(row);
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
    ...(license && registration ? { productKind: 'license' as const, license, registration } : {}),    owner: getAddress(r.owner),
    payTo: getAddress(r.payTo),
    title,
    ...(desc ? { desc } : {}),
    ...(emoji ? { emoji } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(deliveryUrl.ok ? { deliveryUrl: deliveryUrl.url } : {}),
    ...(galleryUrls.length > 0 ? { galleryUrls } : {}),
    ...(details ? { details } : {}),
    ...(specs.length ? { specs } : {}),
    ...(demoUrl ? { demoUrl } : {}),
    priceJpyc: r.priceJpyc,
    contentKind: r.contentKind,
    label,
    ...(category ? { category } : {}),
    ...(tags ? { tags } : {}),
    ...(storedHandle ? { handle: storedHandle } : {}),
    ...(r.featured === true ? { featured: true } : {}),
    // 保存値 true だけを ON とし、false / undefined / 旧 record は OFF。
    ...(r.usdcEnabled === true ? { usdcEnabled: true } : {}),
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

/**
 * 購入時点の表示メタ snapshot。content 本文は含めず、不変 revision の参照だけを
 * PurchaseIntent / ownership 側に保存する (creator-store v4 契約 C/G)。
 */
export type HostedPurchaseMetadata = Pick<
  HostedProduct,
  | 'productKind'
  | 'license'
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
    ...(product.productKind === 'license' ? { productKind: product.productKind, license: product.license } : {}),
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
