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
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import { guardPaidDirectoryApi } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIST_QUERY: DirectoryQuery = {
  limit: DIRECTORY_MAX_LIMIT,
  offset: 0,
};

function paymentHeaderPresent(req: Request): boolean {
  return Boolean(
    req.headers.get('PAYMENT-SIGNATURE') || req.headers.get('x-payment'),
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  if (!paymentHeaderPresent(req)) {
    return handleFirstPartyPaidGet(req, DIRECTORY_LIST_RESOURCE, () =>
      NextResponse.json({ error: 'snapshot_required' }, { status: 503 }),
    );
  }

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
  return handleFirstPartyPaidGet(req, DIRECTORY_LIST_RESOURCE, () =>
    NextResponse.json(envelope),
  );
}
