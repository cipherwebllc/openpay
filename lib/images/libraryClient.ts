// アップロードした画像の一覧と削除のブラウザ側 (GET /api/images・POST /api/images/delete)。例外を投げない (通信の失敗も
// code にして返す・画面は今の一覧を保つ)。今つないでいるウォレットを header で送り、server が cookie の本人と照合する。

import {
  IMAGE_DELETE_ENDPOINT,
  IMAGE_LIBRARY_ENDPOINT,
  IMAGE_LIBRARY_WALLET_HEADER,
  isImageExtension,
  isImageLibraryErrorCode,
  type ImageDeleteTarget,
  type ImageLibraryErrorCode,
  type ImageLibraryItem,
  type ImageUse,
} from '@/lib/images/library';
import { isImagePurpose } from '@/lib/images/purpose';

export type ImageLibraryFailure = ImageLibraryErrorCode | 'network' | 'unknown';

export type ImageLibraryPageResult =
  | { ok: true; images: ImageLibraryItem[]; nextCursor: string | null }
  | { ok: false; error: ImageLibraryFailure };

export type ImageDeleteResult =
  | { ok: true }
  | { ok: false; error: ImageLibraryFailure; usedIn?: ImageUse[] };

// 本文が JSON でない応答 (Vercel の 504 など) は HTTP status から code を決める。
const STATUS_ERROR_CODES: Partial<Record<number, ImageLibraryErrorCode>> = {
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
  503: 'storage_unavailable',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isUse(value: unknown): value is ImageUse {
  const use = record(value);
  if (!use) return false;
  if (use.kind === 'product') {
    return typeof use.id === 'string' && typeof use.title === 'string' && (use.field === 'cover' || use.field === 'gallery');
  }
  if (use.kind === 'profile') {
    return typeof use.handle === 'string' && (use.field === 'avatar' || use.field === 'cover' || use.field === 'link');
  }
  if (use.kind === 'storefront') {
    return typeof use.handle === 'string' && (use.field === 'avatar' || use.field === 'cover' || use.field === 'menu');
  }
  return false;
}

function isUses(value: unknown): value is ImageUse[] {
  return Array.isArray(value) && value.every(isUse);
}

function isItem(value: unknown): value is ImageLibraryItem {
  const item = record(value);
  return (
    !!item &&
    typeof item.id === 'string' &&
    isImageExtension(item.ext) &&
    isImagePurpose(item.purpose) &&
    typeof item.url === 'string' &&
    item.url.startsWith('https://') &&
    typeof item.size === 'number' &&
    typeof item.uploadedAt === 'string' &&
    // 画面は日時を Intl.DateTimeFormat で書く (読めない値だと format が例外を投げる)。
    !Number.isNaN(Date.parse(item.uploadedAt)) &&
    isUses(item.usedIn)
  );
}

function failure(json: Record<string, unknown> | null, status: number): ImageLibraryFailure {
  return isImageLibraryErrorCode(json?.error) ? json.error : (STATUS_ERROR_CODES[status] ?? 'unknown');
}

/** 一覧の 1 ページ。cursor は前のページの nextCursor (最初のページは null)。 */
export async function fetchImageLibraryPage(
  wallet: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ImageLibraryPageResult> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  let response: Response;
  try {
    response = await fetch(`${IMAGE_LIBRARY_ENDPOINT}${query}`, {
      headers: { [IMAGE_LIBRARY_WALLET_HEADER]: wallet },
      cache: 'no-store',
      signal,
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const json = record(await response.json().catch(() => null));
  if (response.ok && json?.ok === true) {
    const { images, nextCursor } = json;
    if (Array.isArray(images) && images.every(isItem) && (nextCursor === null || typeof nextCursor === 'string')) {
      return { ok: true, images, nextCursor };
    }
    return { ok: false, error: 'unknown' };
  }
  return { ok: false, error: failure(json, response.status) };
}

/** 1 枚を消す。204 = 消えた (もう無かった場合も)。409 image_in_use は使っている所 (usedIn) を返す。 */
export async function deleteLibraryImage(wallet: string, target: ImageDeleteTarget): Promise<ImageDeleteResult> {
  let response: Response;
  try {
    response = await fetch(IMAGE_DELETE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IMAGE_LIBRARY_WALLET_HEADER]: wallet },
      body: JSON.stringify({ purpose: target.purpose, id: target.id, ext: target.ext }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (response.status === 204) return { ok: true };
  const json = record(await response.json().catch(() => null));
  const error = failure(json, response.status);
  if (error === 'image_in_use' && isUses(json?.usedIn)) return { ok: false, error, usedIn: json.usedIn };
  return { ok: false, error };
}
