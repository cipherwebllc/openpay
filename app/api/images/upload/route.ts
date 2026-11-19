import { NextResponse } from 'next/server';
import { requireSession } from '@/app/api/auth/siwe/_session';
import { readBytesBodyCapped } from '@/lib/httpBodyCap';
import { BlobDeadlineError, countImagesUnder, putPublicImage } from '@/lib/images/blobStore';
import {
  imageBlobStoreConfigured,
  imageOwnerSecret,
  imageUploadAllowedFor,
  imageUploadMode,
} from '@/lib/images/config';
import { countGlobalImageUpload, secondsUntilNextUtcDay } from '@/lib/images/dailyCap';
import { imageBlobPath, imageOwnerKey, imageOwnerPrefix, newImageId } from '@/lib/images/ownerKey';
import {
  IMAGE_OWNER_MAX_IMAGES,
  IMAGE_UPLOAD_DAILY_PER_IP,
  IMAGE_UPLOAD_DAILY_PER_WALLET,
  IMAGE_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MIME_TYPES,
  isImagePurpose,
  type ImageUploadErrorCode,
  type ImageUploadMimeType,
} from '@/lib/images/purpose';
import { sniffImageType } from '@/lib/images/sniff';
import { logger } from '@/lib/logger';
import { rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit, checkReadRateLimit } from '@/lib/relay/relayGuards';

// 画像のアップロード。本文は画像の byte 列そのもの (Content-Type: image/jpeg か image/png・1 MiB まで)、用途は ?purpose=。
// 認証と枠を通した後に本文を読み、server の put (OIDC) で Vercel Blob の public store に置いて、その URL を返す。
// 保存はしない: 返した URL は画面のフォームに入り、商品・プロフの保存は今と同じ API (任意の https URL を受ける) が行う。
// お金の動き (relay・settle・fee・order) と購入の snapshot には触れない。
// ログは固定の code だけ (アドレス・path・URL・SDK の応答を出さない)。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 本文 1 MiB の読み取り・Blob の list (cursor を追う全体で 5 秒の締切)・put (10 秒の締切) の分。締切で固定の 503 を返せるよう、
// 締切の合計より長くする (lib/images/blobStore)。
export const maxDuration = 20;

const DAY_SEC = 86_400;
// 認証前の IP の制限 (app/api/store/_shared.ts の ipAllowed と同じ数)。未認証の連打にセッションの KV を読ませない。
const IP_RATE_LIMIT_MAX = 60;
const IP_RATE_LIMIT_WINDOW_SEC = 60;

function json(body: unknown, status = 200, headers?: HeadersInit): NextResponse {
  const responseHeaders = new Headers(headers);
  // 応答は要求したウォレットのもの (cookie で決まる)。共有キャッシュに載せない。
  responseHeaders.set('Cache-Control', 'private, no-store');
  responseHeaders.set('Vary', 'Cookie');
  return NextResponse.json(body, { status, headers: responseHeaders });
}

function fail(error: ImageUploadErrorCode, status: number, headers?: HeadersInit): NextResponse {
  return json({ ok: false, error }, status, headers);
}

function rateLimited(retryAfterSec: number): NextResponse {
  return json(
    { ok: false, error: 'rate_limited' satisfies ImageUploadErrorCode, retryAfterSec },
    429,
    { 'Retry-After': String(retryAfterSec) },
  );
}

function declaredType(req: Request): ImageUploadMimeType | null {
  const value = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  return (IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(value ?? '') ? (value as ImageUploadMimeType) : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  // 1) 段階 off なら route は無いのと同じ (認証も KV も読まない)。
  const mode = imageUploadMode();
  if (mode === 'off') return fail('not_found', 404);
  // 2) 別 origin からの書き込み (cookie で認証する) を止める。本文は JSON ではないので Content-Type は 7) で見る。
  const csrf = rejectCrossOriginWrite(req, { json: false });
  if (csrf) return csrf;
  // 3) 認証前の IP の制限 (分ごと)。IP の bucket が作れない (IP_HASH_SECRET が無い・短い・接続元が分からない) と、
  // checkIpRateLimit は数えずに通し、下の IP の 1 日の枠も効かない。ウォレットを作り直せば Blob に書ける量が増えるので、
  // この route では止める (ほかの route の「hash が無ければ飛ばす」とは違う)。止めても URL の欄は使える (掟 13)。
  const ipBucket = hashIpBucket(clientIp(req));
  if (ipBucket === null) return fail('not_configured', 503);
  if (!(await checkIpRateLimit('images-upload', ipBucket, IP_RATE_LIMIT_MAX, IP_RATE_LIMIT_WINDOW_SEC))) {
    return rateLimited(IP_RATE_LIMIT_WINDOW_SEC);
  }
  // 4) SIWE のセッション。
  const session = await requireSession();
  if (!session.ok) {
    session.response.headers.set('Cache-Control', 'private, no-store');
    session.response.headers.set('Vary', 'Cookie');
    return session.response;
  }
  // 5) 段階が admin なら運営者だけ。
  if (!imageUploadAllowedFor(mode, session.address)) return fail('forbidden', 403);
  // 6) ownerKey の秘密と Blob の store。無ければ置き場の path を作れない。
  const secret = imageOwnerSecret();
  if (secret === null || !imageBlobStoreConfigured()) return fail('not_configured', 503);
  // 7) 用途と、宣言した形式。
  const purpose = new URL(req.url).searchParams.get('purpose');
  if (!isImagePurpose(purpose)) return fail('invalid_purpose', 400);
  const contentType = declaredType(req);
  if (contentType === null) return fail('unsupported_media_type', 415);
  // 8) 9) 1 日 (UTC) の回数: ウォレットごと・IP ごと。checkReadRateLimit は KV 障害で通す (既存の limiter と同じ fail-open)。
  if (
    !(await checkReadRateLimit(
      `images:upload:wallet:${session.address.toLowerCase()}`,
      IMAGE_UPLOAD_DAILY_PER_WALLET,
      DAY_SEC,
    ))
  ) {
    return rateLimited(secondsUntilNextUtcDay());
  }
  if (!(await checkReadRateLimit(`images:upload:ip:${ipBucket}`, IMAGE_UPLOAD_DAILY_PER_IP, DAY_SEC))) {
    return rateLimited(secondsUntilNextUtcDay());
  }

  // 10) 本文はここで初めて読む (未認証・枠を超えた要求には読ませない)。上限を超えたら残りを読まずに止める。
  const body = await readBytesBodyCapped(req, IMAGE_UPLOAD_MAX_BYTES);
  if (!body.ok) {
    return body.reason === 'too_large' ? fail('payload_too_large', 413) : fail('invalid_body', 400);
  }
  // 11) 先頭 byte が宣言した形式と同じか。
  if (sniffImageType(body.bytes) !== contentType) return fail('invalid_image', 415);

  // 12) そのウォレットが置いている枚数 (上限に届くか最後のページまで cursor を追う)。数えられなければ止める (上限を確かめずに置かない)。
  const ownerKey = imageOwnerKey(session.address, secret);
  let owned: number;
  try {
    owned = await countImagesUnder(imageOwnerPrefix(ownerKey), IMAGE_OWNER_MAX_IMAGES);
  } catch (error) {
    logger.warn('images.upload.failed', { code: error instanceof BlobDeadlineError ? 'list_deadline' : 'list_failed' });
    return fail('storage_unavailable', 503);
  }
  if (owned >= IMAGE_OWNER_MAX_IMAGES) return fail('image_limit', 409);

  // 13) 全体の 1 日の回数は最後に数える (ここまでで断った要求に全体の枠を使わせない)。KV が無い・失敗したら止める
  // (fail-closed・lib/images/dailyCap)。
  const global = await countGlobalImageUpload();
  if (global === 'unavailable') {
    logger.warn('images.upload.failed', { code: 'global_count_unavailable' });
    return fail('storage_unavailable', 503);
  }
  if (global === 'limited') return rateLimited(secondsUntilNextUtcDay());

  // 14) 置く。
  let url: string;
  try {
    url = await putPublicImage(imageBlobPath(ownerKey, purpose, newImageId(), contentType), body.bytes, contentType);
  } catch (error) {
    // 締切は 503 (Blob が遅い・混んでいる)。ほかの失敗は 502。どちらも SDK の文は出さない。
    if (error instanceof BlobDeadlineError) {
      logger.warn('images.upload.failed', { code: 'put_deadline' });
      return fail('storage_unavailable', 503);
    }
    logger.warn('images.upload.failed', { code: 'put_failed' });
    return fail('upload_failed', 502);
  }
  return json({ ok: true, url });
}
