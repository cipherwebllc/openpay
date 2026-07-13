import { NextResponse } from 'next/server';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import {
  capDirectoryLimit,
  createDirectoryEnvelope,
  queryDirectory,
  validateDirectoryQuery,
} from '@/lib/directory/query';
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

  const query = capDirectoryLimit(parsed.value, 5);
  const result = queryDirectory(DIRECTORY_ENTRIES, query);
  return NextResponse.json(
    createDirectoryEnvelope(query, result, new Date().toISOString()),
    { headers: { 'Cache-Control': DIRECTORY_CACHE_CONTROL } },
  );
}
