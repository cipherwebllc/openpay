// 画像のアップロードのブラウザ側: 下ごしらえ (lib/images/prepare) → POST /api/images/upload → 公開の URL。
// 例外を投げない (通信の失敗も code にして、画面の元の画像と入力を保つ)。

import { prepareUploadImage, type ImagePrepareError } from '@/lib/images/prepare';
import {
  IMAGE_UPLOAD_ENDPOINT,
  isImageUploadErrorCode,
  type ImagePurpose,
  type ImageUploadErrorCode,
  type ImageUploadMimeType,
} from '@/lib/images/purpose';

export type ImageUploadFailure = ImageUploadErrorCode | ImagePrepareError | 'network' | 'unknown';

export type ImageUploadResult =
  | { ok: true; url: string }
  | { ok: false; error: ImageUploadFailure };

// 本文が JSON でない応答 (Vercel の 413・504 など) は HTTP status から code を決める。
const STATUS_ERROR_CODES: Partial<Record<number, ImageUploadErrorCode>> = {
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  502: 'upload_failed',
  503: 'storage_unavailable',
  504: 'upload_failed',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 下ごしらえ済みの画像を送る。signal で取り消せる (取り消した応答は呼び元が捨てる)。 */
export async function postImage(
  blob: Blob,
  type: ImageUploadMimeType,
  purpose: ImagePurpose,
  signal?: AbortSignal,
): Promise<ImageUploadResult> {
  let response: Response;
  try {
    response = await fetch(`${IMAGE_UPLOAD_ENDPOINT}?purpose=${purpose}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body: blob,
      cache: 'no-store',
      signal,
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const json = record(await response.json().catch(() => null));
  if (response.ok && json?.ok === true && typeof json.url === 'string') return { ok: true, url: json.url };
  const code = isImageUploadErrorCode(json?.error) ? json.error : STATUS_ERROR_CODES[response.status];
  return { ok: false, error: code ?? 'unknown' };
}

/** 選んだ file を用途の大きさに描き直して送る。 */
export async function uploadImageFile(
  file: Blob,
  purpose: ImagePurpose,
  signal?: AbortSignal,
): Promise<ImageUploadResult> {
  const prepared = await prepareUploadImage(file, purpose);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  return postImage(prepared.image.blob, prepared.image.type, purpose, signal);
}
