import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import type { ImagePurpose, ImageUploadMimeType } from '@/lib/images/purpose';

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
  return `${imageOwnerPrefix(ownerKey)}${purpose}/${id}.${type === 'image/png' ? 'png' : 'jpg'}`;
}
