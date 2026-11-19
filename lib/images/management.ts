import 'server-only';

import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { requireSession } from '@/lib/siweSession';
import { IMAGE_LIBRARY_DEADLINE_MS } from '@/lib/images/blobStore';
import { imageBlobStoreConfigured, imageOwnerSecret, imageUploadAllowedFor, imageUploadMode } from '@/lib/images/config';
import {
  IMAGE_DELETE_PER_MINUTE_PER_IP,
  IMAGE_DELETE_PER_MINUTE_PER_WALLET,
  IMAGE_LIBRARY_WALLET_HEADER,
  IMAGE_LIST_PER_MINUTE_PER_IP,
  IMAGE_LIST_PER_MINUTE_PER_WALLET,
  type ImageLibraryErrorCode,
} from '@/lib/images/library';
import { imageOwnerKey, imageOwnerPrefix } from '@/lib/images/ownerKey';
import { logger } from '@/lib/logger';
import { rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';
import { clientIp, hashIpBucket } from '@/lib/net/ipHash';
import { checkIpRateLimit, checkReadRateLimit } from '@/lib/relay/relayGuards';

// アップロードした画像の一覧 (GET /api/images) と削除 (POST /api/images/delete) の入口。検査の順:
//  1) 段階 off → 404 (認証も KV も読まない)
//  2) 削除だけ: 別 origin からの書き込み (403)・本文が JSON でない (415)
//  3) 絶対の期限を張る (ここから IMAGE_LIBRARY_DEADLINE_MS = 15 秒で、どの段で待っていても 503 storage_unavailable)
//  4) 画面が今つないでいるウォレット (x-openpay-wallet) の形 (400 invalid_wallet)
//  5) IP の bucket (作れなければ 503 not_configured)・IP の分ごとの枠 (認証の前・429)
//  6) SIWE のセッション (401 / 503)・画面のウォレットと cookie の本人の照合 (401 session_mismatch)
//  7) 段階が admin なら運営者だけ (403)・秘密と Blob の設定 (503 not_configured)
//  8) ウォレットの分ごとの枠 (429)
//  9) 一覧・削除の本体 (handler)
// 枠は checkIpRateLimit・checkReadRateLimit (KV 障害は通す fail-open: 一覧・削除が止まっても決済には波及しないが、KV の
// 障害で本人が自分の画像を消せなくなるのを避ける)。応答はどれも private, no-store + Vary: Cookie。
// ログは固定の code だけ (アドレス・ownerKey・path・URL・SDK の文を出さない)。お金の動きと保存の API には触れない。

export type ImageLibraryKind = 'list' | 'delete';

export type ImageLibraryContext = {
  /** SIWE のセッションのアドレス。 */
  address: string;
  ownerKey: string;
  /** 本人の prefix (`v1/<ownerKey>/`・末尾の / まで)。 */
  prefix: string;
  /** 絶対の期限 (abort されたら次の段を始めない)。 */
  deadline: AbortSignal;
};

const MINUTE_SEC = 60;

const LIMITS: Record<ImageLibraryKind, { ip: number; wallet: number }> = {
  list: { ip: IMAGE_LIST_PER_MINUTE_PER_IP, wallet: IMAGE_LIST_PER_MINUTE_PER_WALLET },
  delete: { ip: IMAGE_DELETE_PER_MINUTE_PER_IP, wallet: IMAGE_DELETE_PER_MINUTE_PER_WALLET },
};

function privateHeaders(response: NextResponse): NextResponse {
  // 応答は cookie の本人のもの。共有キャッシュに載せない。
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  return response;
}

export function imageLibraryJson(body: unknown, status = 200, headers?: HeadersInit): NextResponse {
  return privateHeaders(NextResponse.json(body, { status, headers }));
}

export function imageLibraryFail(error: ImageLibraryErrorCode, status: number, headers?: HeadersInit): NextResponse {
  return imageLibraryJson({ ok: false, error }, status, headers);
}

export function imageLibraryNoContent(): NextResponse {
  return privateHeaders(new NextResponse(null, { status: 204 }));
}

function rateLimited(retryAfterSec: number): NextResponse {
  return imageLibraryJson(
    { ok: false, error: 'rate_limited' satisfies ImageLibraryErrorCode, retryAfterSec },
    429,
    { 'Retry-After': String(retryAfterSec) },
  );
}

/** checkReadRateLimit の固定窓 (時計にそろった windowSec 秒) が切り替わるまでの秒数。 */
function secondsUntilNextWindow(windowSec: number, nowMs = Date.now()): number {
  return windowSec - (Math.floor(nowMs / 1000) % windowSec);
}

/** 失敗のログ (固定の code だけ)。 */
export function logImageLibraryFailure(kind: ImageLibraryKind, code: string): void {
  logger.warn(kind === 'list' ? 'images.list.failed' : 'images.delete.failed', { code });
}

/** 一覧・削除の入口の検査と絶対の期限を通してから handler を動かす。 */
export async function runImageLibraryRequest(
  req: Request,
  kind: ImageLibraryKind,
  handler: (context: ImageLibraryContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  // 1) 段階 off なら route は無いのと同じ。
  const mode = imageUploadMode();
  if (mode === 'off') return imageLibraryFail('not_found', 404);
  // 2) 削除は cookie で認証する書き込み: 別 origin と JSON でない本文を、セッションと本文を読む前に止める。
  if (kind === 'delete') {
    const csrf = rejectCrossOriginWrite(req, { json: true });
    if (csrf) return privateHeaders(csrf);
  }

  // 3) 絶対の期限 (アップロードの route と同じ形)。各段の上限 (KV 5 秒・list / head / del 5 秒) は段ごとに数えるので、
  // 足すと関数の上限 (maxDuration) を超えうる。合計を 1 本の timer で締め、期限で deadline を abort する (Blob はこの signal
  // でも締まり、SDK の送り直しも止まる)。期限の後も handler の続きは動きうるので、handler は次の段 (使っている所の読み取り・
  // del) の前に deadline.aborted を見て、始めない。
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<NextResponse>((resolve) => {
    timer = setTimeout(() => {
      logImageLibraryFailure(kind, 'route_deadline');
      resolve(imageLibraryFail('storage_unavailable', 503));
      deadline.abort();
    }, IMAGE_LIBRARY_DEADLINE_MS);
  });
  try {
    return await Promise.race([guarded(req, kind, mode, deadline.signal, handler), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function guarded(
  req: Request,
  kind: ImageLibraryKind,
  mode: 'admin' | 'all',
  deadline: AbortSignal,
  handler: (context: ImageLibraryContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  // 4) 画面のウォレット (KV を読む前に形だけ)。
  const expected = req.headers.get(IMAGE_LIBRARY_WALLET_HEADER)?.trim() ?? '';
  if (!isAddress(expected, { strict: false })) return imageLibraryFail('invalid_wallet', 400);
  // 5) IP の bucket が作れない (IP_HASH_SECRET が無い・短い・接続元が分からない) と checkIpRateLimit は数えずに通すので、
  // アップロードと同じく止める (止めても決済と保存には波及しない)。
  const ipBucket = hashIpBucket(clientIp(req));
  if (ipBucket === null) return imageLibraryFail('not_configured', 503);
  const limits = LIMITS[kind];
  if (!(await checkIpRateLimit(`images-${kind}`, ipBucket, limits.ip, MINUTE_SEC))) return rateLimited(MINUTE_SEC);
  // 6) SIWE のセッションと、画面のウォレットとの照合。
  const session = await requireSession();
  if (!session.ok) return privateHeaders(session.response);
  if (session.address.toLowerCase() !== expected.toLowerCase()) return imageLibraryFail('session_mismatch', 401);
  // 7) 段階と権限・設定。
  if (!imageUploadAllowedFor(mode, session.address)) return imageLibraryFail('forbidden', 403);
  const secret = imageOwnerSecret();
  if (secret === null || !imageBlobStoreConfigured()) return imageLibraryFail('not_configured', 503);
  // 8) ウォレットの分ごとの枠。
  if (
    !(await checkReadRateLimit(`images:${kind}:wallet:${session.address.toLowerCase()}`, limits.wallet, MINUTE_SEC))
  ) {
    return rateLimited(secondsUntilNextWindow(MINUTE_SEC));
  }
  // 9) 本体。前の段 (KV) を待つ間に期限を過ぎていたら始めない (POST / GET はもう 503 を返している)。
  if (deadline.aborted) return imageLibraryFail('storage_unavailable', 503);
  const ownerKey = imageOwnerKey(session.address, secret);
  return handler({ address: session.address, ownerKey, prefix: imageOwnerPrefix(ownerKey), deadline });
}
