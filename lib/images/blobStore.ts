import 'server-only';

import { list, put } from '@vercel/blob';
import type { ImageUploadMimeType } from '@/lib/images/purpose';

// Vercel Blob (public store) の操作は、この 2 つだけ (presigned・@vercel/blob/client・callback は使わない)。
// 認証は SDK が OIDC (x-vercel-oidc-token / VERCEL_OIDC_TOKEN + BLOB_STORE_ID) で解決する。
// 失敗は例外のまま呼び元へ返す (route が固定の code にしてログに出す: SDK の例外の文は path を含みうるので外に出さない)。

/** 1 年 (秒)。path は乱数で、同じ path を上書きしない (allowOverwrite: false) ので、長く置いてよい。 */
export const IMAGE_CACHE_MAX_AGE_SEC = 365 * 24 * 60 * 60;

// 締切は 2 段。
// - 各操作の上限: list は cursor を追う全体で 5 秒、put は 1 回の呼び出し全体で 10 秒。
// - route の絶対の期限 (IMAGE_UPLOAD_DEADLINE_MS): 要求を受けてからこの時間で、どの段 (KV・本文・Blob) にいても route が
//   503 を返す。route の maxDuration (20 秒) を過ぎると Vercel が関数を止め、固定の code を返せないので、その 5 秒前に置く
//   (応答を書き出す分と、関数の起動・event loop の遅れの余裕)。期限は route が 1 本の timer で決め、AbortSignal で渡す。
// list と put が待つのは「各操作の上限」と「絶対の期限までの残り」の短い方 (前段が時間を使った分だけ短くなる)。
export const BLOB_LIST_DEADLINE_MS = 5_000;
export const BLOB_PUT_DEADLINE_MS = 10_000;
export const IMAGE_UPLOAD_DEADLINE_MS = 15_000;

/** 締切を過ぎた (route は 503 storage_unavailable にする)。 */
export class BlobDeadlineError extends Error {
  constructor() {
    super('blob_deadline');
    this.name = 'BlobDeadlineError';
  }
}

/**
 * run を締切つきで動かす。締切は「limitMs が過ぎた」か「routeDeadline (route の絶対の期限) が abort された」の早い方。
 * 締切で signal を abort し (理由は既定の AbortError)、待たずに BlobDeadlineError で返す。routeDeadline が始めから abort
 * 済みなら、run を呼ばずに BlobDeadlineError (期限を過ぎてから Blob に触れない)。
 * - SDK は失敗 (5xx・通信) を既定 10 回まで、間を空けて送り直す。止めるのは AbortError のときだけ (AbortSignal.timeout の
 *   TimeoutError では止まらない) なので、abort() を理由なしで呼ぶ。送り直しの待ちの最中に締切が来ても、次の送信が
 *   abort 済みの signal で AbortError になり、そこで止まる。
 * - Promise.race で、SDK が待ちの最中でも締切で返す (関数の上限より先に固定の 503 を返すため)。
 */
export async function withBlobDeadline<T>(
  limitMs: number,
  routeDeadline: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (routeDeadline.aborted) throw new BlobDeadlineError();
  const controller = new AbortController();
  let rejectDeadline!: (error: BlobDeadlineError) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const expire = () => {
    // 先に呼び元へ返す結果を決めてから SDK を止める (SDK の AbortError が先に届いても、返るのは BlobDeadlineError)。
    rejectDeadline(new BlobDeadlineError());
    controller.abort();
  };
  const timer = setTimeout(expire, limitMs);
  routeDeadline.addEventListener('abort', expire, { once: true });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    routeDeadline.removeEventListener('abort', expire);
  }
}

/**
 * prefix の下の数を、atLeast に届くか最後のページまで数える (同じ prefix で cursor を追う)。atLeast に届いたらそこで止める
 * (上限の判定に足りる)。ページの途中の失敗・締切・cursor の無い続き (同じページを読み続けてしまう) は例外 (route は 503)。
 * 締切はページごとではなく、cursor を追う全体で 1 つ。
 */
export async function countImagesUnder(prefix: string, atLeast: number, routeDeadline: AbortSignal): Promise<number> {
  return withBlobDeadline(BLOB_LIST_DEADLINE_MS, routeDeadline, async (signal) => {
    let count = 0;
    let cursor: string | undefined;
    while (count < atLeast) {
      const page = await list({ prefix, limit: atLeast - count, cursor, abortSignal: signal });
      count += page.blobs.length;
      if (!page.hasMore) break;
      if (!page.cursor) throw new Error('blob_list_cursor_missing');
      cursor = page.cursor;
    }
    return count;
  });
}

/** 公開の画像を置き、その URL を返す。suffix を足さず、同じ path があれば失敗する (上書きしない)。 */
export async function putPublicImage(
  pathname: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: ImageUploadMimeType,
  routeDeadline: AbortSignal,
): Promise<string> {
  return withBlobDeadline(BLOB_PUT_DEADLINE_MS, routeDeadline, async (signal) => {
    const result = await put(pathname, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: IMAGE_CACHE_MAX_AGE_SEC,
      abortSignal: signal,
    });
    return result.url;
  });
}
