import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import {
  resolveStoreContentAccess,
  type StoreContentSelector,
} from '@/lib/x402/storeContentAccess';
import {
  requireStoreSeller,
  storePrivateJson,
} from '@/app/api/store/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ resourceId: string }>;
};

function notFound(): NextResponse {
  return storePrivateJson({ ok: false, error: 'not_found' }, 404);
}

function storageUnavailable(): NextResponse {
  return storePrivateJson(
    { ok: false, error: 'storage_unavailable' },
    503,
  );
}

const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const CANONICAL_INTENT_SALT_RE = /^0x[0-9a-f]{64}$/;

function contentSelector(req: Request): StoreContentSelector | null {
  const params = new URL(req.url).searchParams;
  const revisions = params.getAll('revision');
  const intentSalts = params.getAll('intentSalt');
  if (revisions.length > 1 || intentSalts.length > 1) return null;

  let revision: number | null = null;
  if (revisions.length === 1) {
    const raw = revisions[0]!;
    if (!POSITIVE_INTEGER_RE.test(raw)) return null;
    revision = Number(raw);
    if (!Number.isSafeInteger(revision)) return null;
  }

  let intentSalt: string | null = null;
  if (intentSalts.length === 1) {
    const raw = intentSalts[0]!;
    if (!CANONICAL_INTENT_SALT_RE.test(raw)) return null;
    intentSalt = raw;
  }
  return { revision, intentSalt };
}

export async function GET(
  req: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'content');
  if (!auth.ok) return auth.response;

  const { resourceId } = await params;
  const selector = contentSelector(req);
  if (!selector) {
    return storePrivateJson(
      { ok: false, error: 'invalid_selector' },
      400,
    );
  }
  const access = await resolveStoreContentAccess({ address: auth.address, resourceId, selector });
  if (access.kind === 'denied') return notFound();
  if (access.kind === 'storage') return storageUnavailable();
  if (access.kind === 'rights_unknown') {
    return storePrivateJson({ ok: false, error: 'license_rights_unknown' }, 503);
  }
  const state = access.kind === 'ready' ? 'ready' : 'provided-ended';
  if (access.source === 'holder') {
    return storePrivateJson({
      ok: true,
      productKind: 'license',
      resourceId,
      title: access.product.title,
      contentRevision: access.contentRevision,
      license: access.license,
      ...access.rights,
      state,
      ...(access.kind === 'ready' ? { kind: access.content.kind, value: access.content.value } : {}),
    });
  }
  const { grant } = access;
  // 来歴 (誰宛の提供か) の明示用 (2026-08-01 user 裁定: 二次流通対策は
  // 「表示による抑止 + 購入記録との突き合わせ根拠」に限定し、ファイル埋め込みはしない)。
  return storePrivateJson({
    ok: true,
    state,
    resourceId,
    title: grant.metadata.title,
    contentRevision: grant.contentRevision,
    intentSalt: grant.intentSalt,
    purchasedAt: grant.purchasedAt,
    txHash: grant.txHash,
    ...(access.kind === 'ready' ? { kind: access.content.kind, value: access.content.value } : {}),
  });
}
