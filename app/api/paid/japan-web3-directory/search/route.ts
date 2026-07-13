import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGet } from '@/app/api/paid/_shared';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { DIRECTORY_SEARCH_RESOURCE } from '@/lib/directory/paidResources';
import {
  createDirectoryEnvelope,
  queryDirectory,
  validateDirectoryQuery,
} from '@/lib/directory/query';
import { guardPaidDirectoryApi, paidDirectoryError } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  const parsed = validateDirectoryQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return paidDirectoryError(parsed.error, 400);

  return handleFirstPartyPaidGet(req, DIRECTORY_SEARCH_RESOURCE, () => {
    const result = queryDirectory(DIRECTORY_ENTRIES, parsed.value);
    return NextResponse.json(
      createDirectoryEnvelope(
        parsed.value,
        result,
        new Date().toISOString(),
      ),
    );
  });
}
