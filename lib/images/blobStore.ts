import 'server-only';

import { list, put } from '@vercel/blob';
import type { ImageUploadMimeType } from '@/lib/images/purpose';

// Vercel Blob (public store) の操作は、この 2 つだけ (presigned・@vercel/blob/client・callback は使わない)。
// 認証は SDK が OIDC (x-vercel-oidc-token / VERCEL_OIDC_TOKEN + BLOB_STORE_ID) で解決する。
// 失敗は例外のまま呼び元へ返す (route が固定の code にしてログに出す: SDK の例外の文は path を含みうるので外に出さない)。

/** 1 年 (秒)。path は乱数で、同じ path を上書きしない (allowOverwrite: false) ので、長く置いてよい。 */
export const IMAGE_CACHE_MAX_AGE_SEC = 365 * 24 * 60 * 60;

// SDK は失敗 (5xx・通信) を既定 10 回まで指数の間隔で送り直す。関数の上限 (route の maxDuration) より前に打ち切り、
// 応答を返せるようにするための上限。
const LIST_TIMEOUT_MS = 5_000;
const PUT_TIMEOUT_MS = 10_000;

/** prefix の下の数 (limit まで)。limit を超えて置かれていても limit までしか数えない (上限の判定に足りる)。 */
export async function countImagesUnder(prefix: string, limit: number): Promise<number> {
  const result = await list({ prefix, limit, abortSignal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  return result.blobs.length;
}

/** 公開の画像を置き、その URL を返す。suffix を足さず、同じ path があれば失敗する (上書きしない)。 */
export async function putPublicImage(
  pathname: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: ImageUploadMimeType,
): Promise<string> {
  const result = await put(pathname, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    access: 'public',
    contentType,
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: IMAGE_CACHE_MAX_AGE_SEC,
    abortSignal: AbortSignal.timeout(PUT_TIMEOUT_MS),
  });
  return result.url;
}
