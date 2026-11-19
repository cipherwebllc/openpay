import type { NextResponse } from 'next/server';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { BlobDeadlineError, BlobResponseError, deleteImageBlob, headImage } from '@/lib/images/blobStore';
import { IMAGE_DELETE_MAX_BODY_BYTES, isImageExtension, type ImageDeleteTarget } from '@/lib/images/library';
import {
  imageLibraryFail,
  imageLibraryJson,
  imageLibraryNoContent,
  logImageLibraryFailure,
  runImageLibraryRequest,
} from '@/lib/images/management';
import { imageBlobPathFor, isImageId } from '@/lib/images/ownerKey';
import { isImagePurpose } from '@/lib/images/purpose';
import { readImageUsage } from '@/lib/images/usage';

// アップロードした画像を本人が消す。本文は {purpose,id,ext} だけ (1 KiB まで・対象を URL のログに載せない)。path は server が
// SIWE の本人の ownerKey から組む (client の URL は使わない = 本人の prefix の外には届かない)。
// 順: head (無ければ 204) → 使っている所を直前に読み直す → 使っていれば 409 image_in_use と使用先 (強制削除はない) →
// del → 204。入口の検査 (段階・同じ origin・IP・セッション・画面のウォレット・運営者・設定・枠) と 15 秒の絶対の期限は
// lib/images/management.ts。期限の後は del を始めない。
// Blob は head 1 回 (Simple operation)・del 1 回 (無料)・KV は入口 5 + 使っている所 2〜4。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 関数の上限。route は要求を受けてから IMAGE_LIBRARY_DEADLINE_MS (15 秒) で必ず返す (lib/images/management)。
export const maxDuration = 20;

const TARGET_KEYS = 'ext,id,purpose';

function parseTarget(value: unknown): ImageDeleteTarget | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // 決めた 3 つの項目だけ (url などを送っても使われると思わせない)。
  if (Object.keys(record).sort().join(',') !== TARGET_KEYS) return null;
  const { purpose, id, ext } = record;
  if (!isImagePurpose(purpose) || !isImageId(id) || !isImageExtension(ext)) return null;
  return { purpose, id, ext };
}

export async function POST(req: Request): Promise<NextResponse> {
  return runImageLibraryRequest(req, 'delete', async ({ address, ownerKey, deadline, pastDeadline }) => {
    const body = await readJsonBodyCapped(req, IMAGE_DELETE_MAX_BODY_BYTES);
    if (!body.ok) {
      return body.reason === 'too_large'
        ? imageLibraryFail('payload_too_large', 413)
        : imageLibraryFail('invalid_body', 400);
    }
    const target = parseTarget(body.value);
    if (target === null) return imageLibraryFail('invalid_body', 400);
    const pathname = imageBlobPathFor(ownerKey, target.purpose, target.id, target.ext);

    // 本文を待つ間に期限を過ぎていたら Blob に触れない。
    let late = pastDeadline();
    if (late) return late;
    let found: { url: string } | null;
    try {
      found = await headImage(pathname, deadline);
    } catch (error) {
      // 締切・応答の形の違い (url がその path の URL でない = 使っている所を照合できない)・ほかの失敗。どれも消さずに 503。
      const code =
        error instanceof BlobDeadlineError ? 'head_deadline' : error instanceof BlobResponseError ? 'head_invalid' : 'head_failed';
      logImageLibraryFailure('delete', code);
      return imageLibraryFail('storage_unavailable', 503);
    }
    // 無い (もう消えた・二重の削除) なら消えた扱い。
    if (found === null) return imageLibraryNoContent();

    // 使っている所は del の直前に読み直す (一覧を出した後に商品・プロフへ入れた画像も止める)。
    late = pastDeadline();
    if (late) return late;
    const read = await readImageUsage(address);
    if (!read.ok) {
      // storage = KV が読めない・unreadable = 本人の記録を読めない。どちらも消さない。
      logImageLibraryFailure('delete', read.reason === 'storage' ? 'usage_unavailable' : 'usage_unreadable');
      return imageLibraryFail('storage_unavailable', 503);
    }
    const usedIn = read.usage.usesOf(found.url);
    if (usedIn.length > 0) return imageLibraryJson({ ok: false, error: 'image_in_use', usedIn }, 409);

    // 使っている所を読む間 (と同期の処理の間) に期限を過ぎていたら消さない。timer の callback を待たず、単調時計でも見る。
    late = pastDeadline();
    if (late) return late;
    try {
      await deleteImageBlob(pathname, deadline);
    } catch (error) {
      logImageLibraryFailure('delete', error instanceof BlobDeadlineError ? 'delete_deadline' : 'delete_failed');
      return imageLibraryFail('storage_unavailable', 503);
    }
    return imageLibraryNoContent();
  });
}
