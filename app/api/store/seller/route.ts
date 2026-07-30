import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import {
  getSellerDisclosure,
  parseSellerDisclosureInput,
  putSellerDisclosure,
} from '@/lib/x402/hostedStore';
import {
  hasOnlyKeys,
  objectValue,
  requireStoreSeller,
  STORE_BODY_MAX_BYTES,
  storePrivateJson,
} from '@/app/api/store/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SELLER_INPUT_KEYS = new Set(['name', 'contact', 'disclosure']);

function notFound(): NextResponse {
  return storePrivateJson({ ok: false, error: 'not_found' }, 404);
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'seller-read');
  if (!auth.ok) return auth.response;

  const seller = await getSellerDisclosure(auth.address);
  if (seller === 'storage') {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  return storePrivateJson({ ok: true, seller });
}

export async function PUT(req: Request): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'seller-write');
  if (!auth.ok) return auth.response;

  const body = await readJsonBodyCapped(req, STORE_BODY_MAX_BYTES);
  if (!body.ok) {
    return storePrivateJson(
      {
        ok: false,
        error:
          body.reason === 'too_large' ? 'payload_too_large' : 'invalid_json',
      },
      body.reason === 'too_large' ? 413 : 400,
    );
  }
  const raw = objectValue(body.value);
  if (!raw) {
    return storePrivateJson({ ok: false, error: 'invalid_body' }, 400);
  }
  if (!hasOnlyKeys(raw, SELLER_INPUT_KEYS)) {
    return storePrivateJson({ ok: false, error: 'invalid_body' }, 400);
  }
  const parsed = parseSellerDisclosureInput({
    name: raw.name,
    contact: raw.contact,
    disclosure: raw.disclosure,
  });
  if (!parsed.ok) {
    return storePrivateJson(
      { ok: false, error: 'invalid_seller', detail: parsed.error },
      400,
    );
  }
  if (!(await putSellerDisclosure(auth.address, parsed.value))) {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  const seller = await getSellerDisclosure(auth.address);
  if (seller === 'storage' || seller === null) {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  return storePrivateJson({ ok: true, seller });
}
