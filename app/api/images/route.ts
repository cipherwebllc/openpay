import type { NextResponse } from 'next/server';
import { BlobDeadlineError, listImagePage } from '@/lib/images/blobStore';
import { IMAGE_LIBRARY_PAGE_SIZE, type ImageLibraryItem } from '@/lib/images/library';
import {
  imageLibraryFail,
  imageLibraryJson,
  logImageLibraryFailure,
  runImageLibraryRequest,
} from '@/lib/images/management';
import { parseOwnedImagePathname } from '@/lib/images/ownerKey';
import { readImageUsage, type ImageUsageIndex } from '@/lib/images/usage';

// アップロードした画像の一覧 (本人の prefix だけ・Blob の順に 24 件ずつ・「もっと見る」で続き)。各行に、本人の handle と
// Store の商品の記録から分かる「使っている所」(usedIn) を付ける。入口の検査 (段階・IP・セッション・画面のウォレット・運営者・
// 設定・枠) と 15 秒の絶対の期限は lib/images/management.ts。
// cursor は Blob の SDK の値をそのまま返し、受けた cursor は本人の prefix の list にそのまま渡す (署名しない)。他人の画像は、
// 返ってきた path を本人の prefix と規定の形で照合して外す (cursor を差し替えても他人の path は返らない)。
// Blob は 1 ページで list 1 回 (Advanced operation)・KV は入口 5 + 使っている所 2〜4 (画像が無いページは読まない)。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 関数の上限。route は要求を受けてから IMAGE_LIBRARY_DEADLINE_MS (15 秒) で必ず返す (lib/images/management)。
export const maxDuration = 20;

// SDK の cursor は不透明な文字列。形だけを見る: 空白・制御文字・ASCII の外を含まない 1〜1024 文字 (長すぎる・おかしな値は
// Blob に送らない)。返ってきた cursor も同じ形でなければ、次の要求が 400 になるので 503 にする。
const CURSOR_RE = /^[\x21-\x7e]{1,1024}$/;

function isListCursor(value: string): boolean {
  return CURSOR_RE.test(value);
}

export async function GET(req: Request): Promise<NextResponse> {
  return runImageLibraryRequest(req, 'list', async ({ address, ownerKey, prefix, deadline }) => {
    const cursors = new URL(req.url).searchParams.getAll('cursor');
    if (cursors.length > 1 || (cursors.length === 1 && !isListCursor(cursors[0]))) {
      return imageLibraryFail('invalid_cursor', 400);
    }
    const cursor = cursors[0];

    let page: Awaited<ReturnType<typeof listImagePage>>;
    try {
      page = await listImagePage(prefix, cursor, IMAGE_LIBRARY_PAGE_SIZE, deadline);
    } catch (error) {
      logImageLibraryFailure('list', error instanceof BlobDeadlineError ? 'list_deadline' : 'list_failed');
      return imageLibraryFail('storage_unavailable', 503);
    }
    // 短いページ (24 件より少ない) でも hasMore に従う。続きがあるのに cursor が無い・前と同じ (同じページを読み続ける)・
    // 形が違う (次の要求が 400 になる) なら、続きを返せないので 503。
    if (page.hasMore && (!page.cursor || page.cursor === cursor || !isListCursor(page.cursor))) {
      logImageLibraryFailure('list', 'list_cursor_invalid');
      return imageLibraryFail('storage_unavailable', 503);
    }

    const owned = page.blobs.flatMap((blob) => {
      const parsed = parseOwnedImagePathname(ownerKey, blob.pathname);
      return parsed ? [{ ...parsed, blob }] : [];
    });
    let usage: ImageUsageIndex | null = null;
    if (owned.length > 0) {
      // list は期限と競争して読む (期限が来たら上の catch で 503)。ここに来たのは期限の前に読めたとき。
      usage = await readImageUsage(address);
      if (usage === null) {
        logImageLibraryFailure('list', 'usage_unavailable');
        return imageLibraryFail('storage_unavailable', 503);
      }
    }
    const images: ImageLibraryItem[] = owned.map(({ purpose, id, ext, blob }) => ({
      id,
      ext,
      purpose,
      url: blob.url,
      size: blob.size,
      uploadedAt: blob.uploadedAt.toISOString(),
      usedIn: usage?.usesOf(blob.url) ?? [],
    }));
    return imageLibraryJson({ ok: true, images, nextCursor: page.hasMore ? page.cursor : null });
  });
}
