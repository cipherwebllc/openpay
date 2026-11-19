import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import { isImageExtension, type ImageExtension } from '@/lib/images/library';
import { isImagePurpose, type ImagePurpose, type ImageUploadMimeType } from '@/lib/images/purpose';

// Blob の path: `v1/<ownerKey>/<purpose>/<id>.<jpg|png>`。
// - ownerKey = HMAC-SHA256(IMAGE_OWNER_KEY_SECRET, 'openpay:image-owner:v1:' + 小文字のアドレス) の先頭 128 bit を base64url
//   (22 文字)。公開 URL から生のアドレスは分からず、KV に対応表を持たずに、同じウォレットの画像を prefix で数え・並べられる。
// - id = crypto の乱数 128 bit の base64url (22 文字)。URL を推測できない。
// - path は短くする: 注文リンクは設定 (画像の URL を含む) を URL と QR に入れる。

const OWNER_KEY_LABEL = 'openpay:image-owner:v1:';
const KEY_BYTES = 16;

export const IMAGE_PATH_VERSION = 'v1';

export function imageOwnerKey(address: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${OWNER_KEY_LABEL}${address.toLowerCase()}`)
    .digest()
    .subarray(0, KEY_BYTES)
    .toString('base64url');
}

export function newImageId(): string {
  return randomBytes(KEY_BYTES).toString('base64url');
}

/** そのウォレットの画像だけを数える・並べる list の prefix (末尾の / まで含める)。 */
export function imageOwnerPrefix(ownerKey: string): string {
  return `${IMAGE_PATH_VERSION}/${ownerKey}/`;
}

export function imageBlobPath(
  ownerKey: string,
  purpose: ImagePurpose,
  id: string,
  type: ImageUploadMimeType,
): string {
  return imageBlobPathFor(ownerKey, purpose, id, type === 'image/png' ? 'png' : 'jpg');
}

/** 拡張子から path を組む (削除: 本文の {purpose,id,ext} と SIWE の本人の ownerKey から。client の URL は使わない)。 */
export function imageBlobPathFor(ownerKey: string, purpose: ImagePurpose, id: string, ext: ImageExtension): string {
  return `${imageOwnerPrefix(ownerKey)}${purpose}/${id}.${ext}`;
}

// newImageId の形 (128 bit の base64url = 22 文字)。"/"・"." を含まないので、path の段を越えられない。
const IMAGE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function isImageId(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_ID_RE.test(value);
}

/**
 * 一覧の list が返した path が、その本人の規定の形 (`v1/<ownerKey>/<purpose>/<id>.<jpg|png>`) かを確かめて分ける。
 * 合わないもの (ほかの本人の prefix・段の数・用途・id・拡張子の違い) は null (一覧に出さない)。
 */
export function parseOwnedImagePathname(
  ownerKey: string,
  pathname: string,
): { purpose: ImagePurpose; id: string; ext: ImageExtension } | null {
  const prefix = imageOwnerPrefix(ownerKey);
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split('/');
  if (parts.length !== 2) return null;
  const [purpose, file] = parts;
  const dot = file.lastIndexOf('.');
  const id = file.slice(0, dot);
  const ext = file.slice(dot + 1);
  if (dot < 0 || !isImagePurpose(purpose) || !isImageId(id) || !isImageExtension(ext)) return null;
  return { purpose, id, ext };
}
