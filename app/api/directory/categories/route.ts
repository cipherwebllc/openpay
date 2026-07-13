import { NextResponse } from 'next/server';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { directoryCategoryCounts } from '@/lib/directory/query';
import {
  DIRECTORY_CACHE_CONTROL,
  guardFreeDirectoryApi,
} from '../_shared';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = await guardFreeDirectoryApi(req);
  if (guarded) return guarded;

  const items = directoryCategoryCounts(DIRECTORY_ENTRIES);
  return NextResponse.json(
    {
      schemaVersion: '1.0',
      items,
      total: items.length,
      generatedAt: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': DIRECTORY_CACHE_CONTROL } },
  );
}
