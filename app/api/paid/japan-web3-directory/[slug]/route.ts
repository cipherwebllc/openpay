import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGet } from '@/app/api/paid/_shared';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { directoryDetailResource } from '@/lib/directory/paidResources';
import {
  createDirectoryEnvelope,
  findPublishedDirectoryEntry,
} from '@/lib/directory/query';
import { guardPaidDirectoryApi, paidDirectoryError } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  const { slug } = await params;
  const entry = findPublishedDirectoryEntry(DIRECTORY_ENTRIES, slug);
  // 存在確認を payment challenge より先に行い、未存在 slug では署名も課金も発生させない。
  if (!entry) return paidDirectoryError('not_found', 404);

  return handleFirstPartyPaidGet(req, directoryDetailResource(slug), () =>
    NextResponse.json(
      createDirectoryEnvelope(
        { slug },
        { items: [entry], total: 1 },
        new Date().toISOString(),
      ),
    ),
  );
}
