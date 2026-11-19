import 'server-only';

import { BlobNotFoundError, del, head, list, put } from '@vercel/blob';
import type { ImageUploadMimeType } from '@/lib/images/purpose';

// Vercel Blob (public store) の操作は list・put と、一覧・削除 (GET /api/images・POST /api/images/delete) の head・del だけ
// (presigned・@vercel/blob/client・callback は使わない)。
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
// 一覧・削除: head と del は各 5 秒。route の絶対の期限はアップロードと同じ形で 15 秒 (maxDuration 20 秒の 5 秒前)。
export const BLOB_HEAD_DEADLINE_MS = 5_000;
export const BLOB_DEL_DEADLINE_MS = 5_000;
export const IMAGE_LIBRARY_DEADLINE_MS = 15_000;

/** 締切を過ぎた (route は 503 storage_unavailable にする)。 */
export class BlobDeadlineError extends Error {
  constructor() {
    super('blob_deadline');
    this.name = 'BlobDeadlineError';
  }
}

/**
 * Blob の応答の形が決めた形でない (route は 503 storage_unavailable にする)。SDK は 200 の応答の中身を確かめずに返すので
 * (url が無くても成功を返す)、一覧と削除はここで確かめる: 確かめずに進むと、url の無い head で「使っている所」が見つからずに
 * 消してしまう・読めない日時で 500 になる。
 */
export class BlobResponseError extends Error {
  constructor() {
    super('blob_response');
    this.name = 'BlobResponseError';
  }
}

/** url が https で、その path が pathname と同じ (`/<pathname>`) か。 */
function urlIsFor(url: unknown, pathname: string): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.pathname === `/${pathname}`;
  } catch {
    return false;
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
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
 * 締切はページごとではなく、cursor を追う全体で 1 つ。pastDeadline (route の単調時計の期限) を渡すと、2 ページ目からは読む前に
 * それも見て、過ぎていたら次のページを読まずに締切として止める (timer の callback より先に期限をまたいだとき)。
 */
export async function countImagesUnder(
  prefix: string,
  atLeast: number,
  routeDeadline: AbortSignal,
  pastDeadline?: () => boolean,
): Promise<number> {
  return withBlobDeadline(BLOB_LIST_DEADLINE_MS, routeDeadline, async (signal) => {
    let count = 0;
    let cursor: string | undefined;
    while (count < atLeast) {
      if (cursor !== undefined && pastDeadline?.()) throw new BlobDeadlineError();
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

/** 一覧の 1 ページ (list の結果のうち route が使う所だけ)。 */
export type ImageListPage = {
  blobs: { pathname: string; url: string; size: number; uploadedAt: Date }[];
  cursor: string | undefined;
  hasMore: boolean;
};

/**
 * prefix の下を 1 ページだけ読む (cursor は前のページの list が返した値をそのまま渡す)。締切は list の上限 (5 秒) と route の
 * 絶対の期限の早い方。続きの有無・cursor の形の判定は呼び元 (route) がする。行の形 (path・その path の https の url・大きさ・
 * 読める日時) と続きの有無が決めた形でなければ BlobResponseError (どの本人の行かの照合は route がする)。
 */
export async function listImagePage(
  prefix: string,
  cursor: string | undefined,
  limit: number,
  routeDeadline: AbortSignal,
): Promise<ImageListPage> {
  return withBlobDeadline(BLOB_LIST_DEADLINE_MS, routeDeadline, async (signal) => {
    const page = await list({ prefix, limit, cursor, abortSignal: signal });
    if (!Array.isArray(page.blobs) || typeof page.hasMore !== 'boolean') throw new BlobResponseError();
    const blobs = page.blobs.map(({ pathname, url, size, uploadedAt }) => {
      if (
        typeof pathname !== 'string' ||
        !urlIsFor(url, pathname) ||
        typeof size !== 'number' ||
        !Number.isFinite(size) ||
        size < 0 ||
        !validDate(uploadedAt)
      ) {
        throw new BlobResponseError();
      }
      return { pathname, url, size, uploadedAt };
    });
    return { blobs, cursor: typeof page.cursor === 'string' ? page.cursor : undefined, hasMore: page.hasMore };
  });
}

/**
 * path の画像の公開 URL。無ければ null (SDK の BlobNotFoundError = 送り直さない失敗)。ほかの失敗は例外。応答の url がその path の
 * https の URL でなければ BlobResponseError (使っている所を照合できないまま消さない)。
 */
export async function headImage(pathname: string, routeDeadline: AbortSignal): Promise<{ url: string } | null> {
  return withBlobDeadline(BLOB_HEAD_DEADLINE_MS, routeDeadline, async (signal) => {
    let blob: Awaited<ReturnType<typeof head>>;
    try {
      blob = await head(pathname, { abortSignal: signal });
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
    if (!urlIsFor(blob?.url, pathname)) throw new BlobResponseError();
    return { url: blob.url };
  });
}

/** path の画像を消す。無かった (BlobNotFoundError) ときも消えた扱いで返す。ほかの失敗は例外。 */
export async function deleteImageBlob(pathname: string, routeDeadline: AbortSignal): Promise<void> {
  await withBlobDeadline(BLOB_DEL_DEADLINE_MS, routeDeadline, async (signal) => {
    try {
      await del(pathname, { abortSignal: signal });
    } catch (error) {
      if (!(error instanceof BlobNotFoundError)) throw error;
    }
  });
}
