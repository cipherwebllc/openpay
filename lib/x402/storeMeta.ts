// OpenPay Store の商品メタデータ定義 (カテゴリー / 商品タイプ / タグ)。
//
// plans/store-marketplace.md P1。**表示・検索専用**のメタデータで、購入 snapshot
// (hostedPurchaseMetadata) には一切入らない (money-path 不変・掟 12/15)。
// server (hostedStore の検証) と client (出品 UI / カード表示 / Store 一覧) の両方から
// import するため、この module は browser-safe に保つ (env・KV・viem に依存しない)。
//
// 拡張方法: カテゴリーは HOSTED_PRODUCT_CATEGORIES に 1 行足し、messages/{ja,en}.json の
// StoreCatalog.categories に対訳を足すだけ (i18n parity テストが漏れを検出する)。

import { stripControlChars } from '@/lib/sanitize';

/** 商品カテゴリー (MVP 9 種・順序は Store のフィルタ表示順)。 */
export const HOSTED_PRODUCT_CATEGORIES = [
  'ai',
  'documents',
  'software',
  'images-nft',
  'video',
  'music',
  'templates',
  '3d-game',
  'other',
] as const;

export type HostedProductCategory = (typeof HOSTED_PRODUCT_CATEGORIES)[number];

export function isHostedProductCategory(
  value: unknown,
): value is HostedProductCategory {
  return (
    typeof value === 'string' &&
    (HOSTED_PRODUCT_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * 商品タイプ (受け取り方)。独立フィールドにせず既存 HostedLabel から導出する —
 * label は既に「受け取り方の細分」(download/pdf/zip/prompt/api/external) を出品者が
 * 選んでおり、二重入力を作ると必ず矛盾する (裁定 2026-08-02)。既存レコードも
 * 自動で 4 タイプに対応する。
 */
export const HOSTED_PRODUCT_TYPES = [
  'download',
  'external-link',
  'api',
  'other',
] as const;

export type HostedProductType = (typeof HOSTED_PRODUCT_TYPES)[number];

export function productTypeForLabel(label: string): HostedProductType {
  switch (label) {
    case 'download':
    case 'pdf':
    case 'zip':
      return 'download';
    case 'external':
      return 'external-link';
    case 'api':
      return 'api';
    default:
      // prompt・未知 label は Other (テキスト納品など)。
      return 'other';
  }
}

/** タグ: 最大 5 個・各 24 文字 (code point)。検索・表示用の公開 UGC 文字列。 */
export const MAX_HOSTED_TAGS = 5;
export const MAX_HOSTED_TAG_LEN = 24;

export type ParsedTags =
  | { ok: true; tags?: readonly string[] }
  | { ok: false; error: string };

/**
 * タグ入力の検証 (server 権威・出品 UI も同じ関数でプレビュー検証)。
 * 制御文字は除去し、空になったタグ・重複は黙って落とす (出品を止めるのは
 * 「数が多すぎる」「長すぎる」の明示的な違反のみ)。
 */
export function parseHostedTags(raw: unknown): ParsedTags {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid tags' };
  if (raw.length > MAX_HOSTED_TAGS) return { ok: false, error: 'too many tags' };
  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') return { ok: false, error: 'invalid tags' };
    const cleaned = stripControlChars(value).trim();
    if (!cleaned) continue;
    if ([...cleaned].length > MAX_HOSTED_TAG_LEN) {
      return { ok: false, error: 'tag too long' };
    }
    if (!tags.includes(cleaned)) tags.push(cleaned);
  }
  return { ok: true, ...(tags.length > 0 ? { tags } : {}) };
}
