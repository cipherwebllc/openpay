import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGetFromSnapshot } from '@/app/api/paid/_shared';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { DIRECTORY_LIST_RESOURCE } from '@/lib/directory/paidResources';
import {
  createDirectoryEnvelope,
  queryDirectory,
} from '@/lib/directory/query';
import type { DirectoryQuery } from '@/lib/directory/types';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import { guardPaidDirectoryApi } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_QUERY: DirectoryQuery = {
  // 全件 export を検索用の 50 件上限で切らない。非公開行は queryDirectory が除外する。
  limit: DIRECTORY_ENTRIES.length,
  offset: 0,
};

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  // snapshot の先読み / lazy の切り替えは helper (支払い前に KV を読む条件・再配信時の扱い) に集約。
  return handleFirstPartyPaidGetFromSnapshot(req, DIRECTORY_LIST_RESOURCE, async () => {
    const verificationSnapshot = await readDirectoryVerificationSnapshot();
    if (verificationSnapshot === null) {
      return NextResponse.json(
        { ok: false, error: 'storage_unavailable' },
        { status: 503 },
      );
    }
    const result = queryDirectory(DIRECTORY_ENTRIES, LIST_QUERY);
    const envelope = createDirectoryEnvelope(
      LIST_QUERY,
      result,
      new Date().toISOString(),
      verificationSnapshot,
    );
    return NextResponse.json(envelope);
  });
}
