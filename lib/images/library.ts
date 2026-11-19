// アップロードした画像の一覧 (GET /api/images) と削除 (POST /api/images/delete) の、ブラウザと server で共有する定数と型。
// 秘密や env を読まない (client の bundle に入る)。server の処理は lib/images/management.ts (入口の検査)・
// lib/images/usage.ts (使っている所)・lib/images/blobStore.ts (Blob の list・head・del)。

import type { ImagePurpose } from '@/lib/images/purpose';

export const IMAGE_LIBRARY_ENDPOINT = '/api/images';
export const IMAGE_DELETE_ENDPOINT = '/api/images/delete';

/** 一覧の 1 ページの数 (Blob の list の limit)。 */
export const IMAGE_LIBRARY_PAGE_SIZE = 24;

/**
 * 画面が「今つないでいるウォレット」を server へ伝える header。server は SIWE の cookie の本人と照合し、違えば 401
 * session_mismatch (別のタブで別のウォレットにサインインし直した後の古い画面から、cookie の本人の画像を消した・並べたと
 * 見せない)。本文と URL には載せない (URL はログに残る・削除の本文は {purpose,id,ext} だけ)。
 */
export const IMAGE_LIBRARY_WALLET_HEADER = 'x-openpay-wallet';

/** 削除の本文の上限 (byte)。本文は {purpose,id,ext} だけ。 */
export const IMAGE_DELETE_MAX_BODY_BYTES = 1024;

/** 置き場の拡張子 (path の末尾)。JPEG は jpg・PNG は png (lib/images/ownerKey の imageBlobPath と同じ)。 */
export const IMAGE_EXTENSIONS = ['jpg', 'png'] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

export function isImageExtension(value: unknown): value is ImageExtension {
  return typeof value === 'string' && (IMAGE_EXTENSIONS as readonly string[]).includes(value);
}

/**
 * その画像を使っている所 (server が本人の handle と Store の商品の記録を読んで分かる範囲)。この端末のレジの商品・下書き・
 * 配った注文リンクや QR は server から見えないので含まない (画面は消す前の確認で伝える)。
 */
export type ImageUse =
  | { kind: 'product'; id: string; title: string; field: 'cover' | 'gallery' }
  | { kind: 'profile'; handle: string; field: 'avatar' | 'cover' | 'link' }
  | { kind: 'storefront'; handle: string; field: 'avatar' | 'cover' | 'menu' };

/** 一覧の 1 行。url は公開の Blob の URL (サムネに使う)。uploadedAt は UTC の ISO 8601。 */
export type ImageLibraryItem = {
  id: string;
  ext: ImageExtension;
  purpose: ImagePurpose;
  url: string;
  size: number;
  uploadedAt: string;
  usedIn: ImageUse[];
};

/** 削除の対象 (server がこれと SIWE の本人から path を組む・client の URL は使わない)。 */
export type ImageDeleteTarget = { purpose: ImagePurpose; id: string; ext: ImageExtension };

/** 2 つの API が返す固定の code (応答の `error`)。 */
export const IMAGE_LIBRARY_ERROR_CODES = [
  'not_found',
  'cross_site_request',
  'unsupported_media_type',
  'rate_limited',
  'invalid_wallet',
  'unauthenticated',
  'session_mismatch',
  'session_storage_unavailable',
  'forbidden',
  'not_configured',
  'invalid_cursor',
  'invalid_body',
  'payload_too_large',
  'image_in_use',
  'storage_unavailable',
] as const;
export type ImageLibraryErrorCode = (typeof IMAGE_LIBRARY_ERROR_CODES)[number];

export function isImageLibraryErrorCode(value: unknown): value is ImageLibraryErrorCode {
  return typeof value === 'string' && (IMAGE_LIBRARY_ERROR_CODES as readonly string[]).includes(value);
}

/** 1 分あたりの回数 (一覧・削除)。IP ごとは認証の前・ウォレットごとは認証の後に数える。 */
export const IMAGE_LIST_PER_MINUTE_PER_IP = 60;
export const IMAGE_LIST_PER_MINUTE_PER_WALLET = 30;
export const IMAGE_DELETE_PER_MINUTE_PER_IP = 20;
export const IMAGE_DELETE_PER_MINUTE_PER_WALLET = 10;
