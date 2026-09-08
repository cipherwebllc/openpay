import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { listStoreLibraryPage } from '@/lib/x402/storeEntitlement';
import {
  requireStoreSeller,
  storePrivateJson,
} from '@/app/api/store/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notFound(): NextResponse {
  return storePrivateJson({ ok: false, error: 'not_found' }, 404);
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'library');
  if (!auth.ok) return auth.response;

  const cursor = new URL(req.url).searchParams.get('cursor');
  if (new URL(req.url).searchParams.get('source') === 'holders') {
    const { listHeldLicenses } = await import('@/lib/license/holders');
    const held = await listHeldLicenses(auth.address, cursor);
    if (!held.ok) return storePrivateJson({ ok: false, error: held.reason }, held.reason === 'invalid_cursor' ? 400 : held.reason === 'not_found' ? 404 : 503);
    return storePrivateJson({ ok: true, source: 'holders', ...held.page });
  }
  const result = await listStoreLibraryPage({
    payer: auth.address,
    cursor,
  });
  if (!result.ok) {
    if (result.reason === 'invalid_cursor') {
      return storePrivateJson(
        { ok: false, error: 'invalid_cursor' },
        400,
      );
    }
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  return storePrivateJson({ ok: true, ...result.page });
}
