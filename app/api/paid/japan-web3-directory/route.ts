import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGet } from '@/app/api/paid/_shared';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { DIRECTORY_LIST_RESOURCE } from '@/lib/directory/paidResources';
import {
  createDirectoryEnvelope,
  DIRECTORY_MAX_LIMIT,
  queryDirectory,
} from '@/lib/directory/query';
import type { DirectoryQuery } from '@/lib/directory/types';
import { guardPaidDirectoryApi } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_QUERY: DirectoryQuery = {
  limit: DIRECTORY_MAX_LIMIT,
  offset: 0,
};

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  return handleFirstPartyPaidGet(req, DIRECTORY_LIST_RESOURCE, () => {
    const result = queryDirectory(DIRECTORY_ENTRIES, LIST_QUERY);
    return NextResponse.json(
      createDirectoryEnvelope(LIST_QUERY, result, new Date().toISOString()),
    );
  });
}
