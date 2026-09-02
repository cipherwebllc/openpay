import { NextResponse } from 'next/server';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  capDirectoryLimit,
  createDirectoryEnvelope,
  queryDirectory,
  validateDirectoryQuery,
} from '@/lib/directory/query';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import {
  DIRECTORY_CACHE_CONTROL,
  directoryError,
  guardFreeDirectoryApi,
} from './_shared';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = await guardFreeDirectoryApi(req);
  if (guarded) return guarded;

  const parsed = validateDirectoryQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return directoryError(parsed.error, 400);

  // 無料 teaser は limit だけでなく offset も 0 に固定する。limit のみを絞ると、offset を
  // 進めながら数回叩けば無料枠のまま全件 (最大 1000 件分) を持ち出せてしまう (E5)。
  const query = { ...capDirectoryLimit(parsed.value, 5), offset: 0 };
  const verificationSnapshot = await readDirectoryVerificationSnapshot();
  if (verificationSnapshot === null) {
    return directoryError('storage_unavailable', 503);
  }
  const result = queryDirectory(DIRECTORY_ENTRIES, query);
  return NextResponse.json(
    { ...createDirectoryEnvelope(query, result, new Date().toISOString(), verificationSnapshot), teaser: true },
    { headers: { 'Cache-Control': DIRECTORY_CACHE_CONTROL } },
  );
}
