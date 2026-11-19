// AI 出品アシスタント (Google Gemini で出品文の案を作る・運営者だけの試し・既定 OFF) の、client と server で共有する部分:
// Google に送る欄の許可リスト・フォームからの抽出・API の入出力の型と上限。
// browser-safe に保つ (env・KV・server-only を import しない)。設定・検証・Gemini の呼び出しは lib/store/listingAssistantServer.ts。

import type { ProductForm } from '@/lib/store/productForm';

/**
 * 出品フォームの欄ごとに、Google (Gemini) へ送るかを決める許可リスト。**ProductForm の全 key を網羅する** —
 * フォームに欄を足すと、ここで分類するまで typecheck が落ちる (送るかどうかを決めずに欄が増えない)。
 * send = 商品ページに公開される説明の欄だけ。有料の本文・納品先・受取先・価格・ライセンス・画像の URL・掲載先などは never。
 * 販売者情報 (氏名・連絡先・開示文) は ProductForm に無く (SellerForm)、抽出の入口 (listingAssistantFactsOf) が受け取らない。
 */
export const LISTING_ASSISTANT_FIELD_POLICY = {
  productKind: 'never',
  supply: 'never',
  transferable: 'never',
  termsPreset: 'never',
  termsUrl: 'never',
  termsVersion: 'never',
  payTo: 'never',
  title: 'send',
  desc: 'send',
  emoji: 'never',
  imageUrl: 'never',
  deliveryUrl: 'never',
  galleryUrls: 'never',
  details: 'send',
  specs: 'send',
  demoUrl: 'never',
  usageCommercial: 'send',
  usageModify: 'send',
  usageRedistribute: 'send',
  usageNote: 'send',
  priceJpyc: 'never',
  contentKind: 'never',
  label: 'never',
  category: 'send',
  tags: 'send',
  listingHandle: 'never',
  featured: 'never',
  content: 'never',
  saleActive: 'never',
  usdcEnabled: 'never',
} as const satisfies Record<keyof ProductForm, 'send' | 'never'>;

type FieldPolicy = typeof LISTING_ASSISTANT_FIELD_POLICY;

/** Google に送る欄の key (許可リストの send)。 */
export type ListingAssistantFactKey = {
  [K in keyof FieldPolicy]: FieldPolicy[K] extends 'send' ? K : never;
}[keyof FieldPolicy];

/** 送る欄の値 (フォームの文字列のまま・key は許可リストの send とちょうど同じ)。 */
export type ListingAssistantFacts = Pick<ProductForm, ListingAssistantFactKey>;

export const LISTING_ASSISTANT_FACT_KEYS: readonly ListingAssistantFactKey[] = (
  Object.keys(LISTING_ASSISTANT_FIELD_POLICY) as (keyof FieldPolicy)[]
).filter((key): key is ListingAssistantFactKey => LISTING_ASSISTANT_FIELD_POLICY[key] === 'send');

/**
 * フォームから送る欄だけを 1 つずつ取り出す (spread や key の走査で写さない = never の欄が混ざる経路を作らない)。
 * 利用ライセンス商品は専用の利用条件 (lib/license) を持ち、普通の商品の利用条件は保存もしない (server が拒否する) ので空にする。
 */
export function listingAssistantFactsOf(form: ProductForm): ListingAssistantFacts {
  const license = form.productKind === 'license';
  return {
    title: form.title,
    desc: form.desc,
    details: form.details,
    specs: form.specs,
    usageCommercial: license ? '' : form.usageCommercial,
    usageModify: license ? '' : form.usageModify,
    usageRedistribute: license ? '' : form.usageRedistribute,
    usageNote: license ? '' : form.usageNote,
    category: form.category,
    tags: form.tags,
  };
}

/** メモの上限 (前後の空白を除いた code point 数)。 */
export const LISTING_ASSISTANT_MEMO_MAX = 500;
/** 画像は JPEG 1 枚・復号後 1 MiB まで (画面で縮めてから送る)。 */
export const LISTING_ASSISTANT_IMAGE_MIME_TYPE = 'image/jpeg';
export const LISTING_ASSISTANT_IMAGE_MAX_BYTES = 1024 * 1024;

export type ListingAssistantImage = {
  mimeType: typeof LISTING_ASSISTANT_IMAGE_MIME_TYPE;
  /** 標準の base64 (改行なし)。 */
  data: string;
};

/** POST /api/store/seller/listing-assistant の本文。メモ (空白を除いて 1 字以上) か画像のどちらかが要る。 */
export type ListingAssistantRequest = {
  memo?: string;
  image?: ListingAssistantImage;
  facts: ListingAssistantFacts;
};

/** 出力の上限。商品名・説明・タグは保存の上限 (lib/x402/hostedStore・storeMeta) と同じ値を server が使う。 */
export const LISTING_ASSISTANT_EN_MAX = 400;
export const LISTING_ASSISTANT_X_MAX = 120;
export const LISTING_ASSISTANT_CHECKS_MAX = 5;
export const LISTING_ASSISTANT_CHECK_MAX = 100;

/**
 * 案の 1 欄。fits = 保存と同じ検証 (sanitizeLine・parseHostedTags) を上限内で通る。false (長すぎる・空) の欄は
 * 画面が「〜に入れる」を止める (文字は見せる)。長さの超過で案の全体を捨てない。
 */
export type ListingAssistantDraftField<T> = { value: T; fits: boolean };

export type ListingAssistantDraft = {
  /** 商品名 (日本語)。 */
  title: ListingAssistantDraftField<string>;
  /** 短い説明 (日本語)。 */
  desc: ListingAssistantDraftField<string>;
  tags: ListingAssistantDraftField<string[]>;
  /** 英語の紹介 (コピー用)。 */
  en: ListingAssistantDraftField<string>;
  /** X の投稿文 (コピー用・URL なし)。 */
  x: ListingAssistantDraftField<string>;
  /** 出品者に確かめてほしい点 (販売文に入れない)。 */
  checks: ListingAssistantDraftField<string[]>;
};

/**
 * 失敗の code。cross_site_request (403)・unsupported_media_type (415)・unauthenticated (401)・
 * session_storage_unavailable (503) は既存の共通の検査がそのまま返す。
 */
export type ListingAssistantErrorCode =
  | 'not_found'
  | 'cross_site_request'
  | 'unsupported_media_type'
  | 'invalid_json'
  | 'payload_too_large'
  | 'unauthenticated'
  | 'session_storage_unavailable'
  | 'forbidden'
  | 'rate_limited'
  | 'invalid_body'
  | 'invalid_memo'
  | 'invalid_image'
  | 'image_too_large'
  | 'invalid_facts'
  | 'memo_or_image_required'
  | 'blocked'
  | 'quota_exceeded'
  | 'bad_response'
  | 'truncated'
  | 'not_configured'
  | 'unavailable'
  | 'timeout';

export type ListingAssistantResponse =
  | { ok: true; draft: ListingAssistantDraft }
  | { ok: false; error: ListingAssistantErrorCode; retryAfterSec?: number };
