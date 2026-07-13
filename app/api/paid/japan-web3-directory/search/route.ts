import { NextResponse } from 'next/server';
import { handleFirstPartyPaidGet } from '@/app/api/paid/_shared';
import { DIRECTORY_ENTRIES } from '@/lib/directory/data';
import { DIRECTORY_SEARCH_RESOURCE } from '@/lib/directory/paidResources';
import {
  createDirectoryEnvelope,
  queryDirectory,
  validateDirectoryQuery,
} from '@/lib/directory/query';
import { readDirectoryVerificationSnapshot } from '@/lib/directory/verification';
import { guardPaidDirectoryApi, paidDirectoryError } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function paymentHeaderPresent(req: Request): boolean {
  return Boolean(
    req.headers.get('PAYMENT-SIGNATURE') || req.headers.get('x-payment'),
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  const guarded = guardPaidDirectoryApi();
  if (guarded) return guarded;

  const parsed = validateDirectoryQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return paidDirectoryError(parsed.error, 400);

  if (!paymentHeaderPresent(req)) {
    return handleFirstPartyPaidGet(req, DIRECTORY_SEARCH_RESOURCE, () =>
      NextResponse.json({ error: 'snapshot_required' }, { status: 503 }),
    );
  }

  const verificationSnapshot = await readDirectoryVerificationSnapshot();
  if (verificationSnapshot === null) {
    return paidDirectoryError('storage_unavailable', 503);
  }
  const result = queryDirectory(DIRECTORY_ENTRIES, parsed.value);
  const envelope = createDirectoryEnvelope(
    parsed.value,
    result,
    new Date().toISOString(),
    verificationSnapshot,
  );
  return handleFirstPartyPaidGet(req, DIRECTORY_SEARCH_RESOURCE, () =>
    NextResponse.json(envelope),
  );
}
