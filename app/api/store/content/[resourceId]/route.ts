import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import {
  resolveStoreContentAccess,
  parseStoreContentSelector,
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

export async function GET(
  req: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  if (!env.enableCreatorStore) return notFound();
  const auth = await requireStoreSeller(req, 'content');
  if (!auth.ok) return auth.response;

  const { resourceId } = await params;
  const selector = parseStoreContentSelector(req);
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
  // OFF 時は鍵モジュールに到達せず、既存の HTTP serializer を維持する。
  let delivery: { mode: 'ticket'; href: string } | undefined;
  if (access.kind === 'ready' && env.enableStoreDeliveryTicket && access.product.deliveryUrl) {
    const { deliveryTicketConfig } = await import('@/lib/store/deliveryTicket');
    const { parseDeliveryUrl } = await import('@/lib/store/deliveryUrl');
    if (parseDeliveryUrl(access.product.deliveryUrl).ok && deliveryTicketConfig()) {
      const revision = access.source === 'holder' ? 1 : access.grant.contentRevision;
      const salt = access.source === 'purchase' && selector.intentSalt !== null
        ? `&intentSalt=${access.grant.intentSalt}` : '';
      delivery = { mode: 'ticket', href: `/api/store/delivery/${resourceId}?revision=${revision}${salt}` };
    }
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
      ...(delivery ? { delivery } : {}),
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
    ...(delivery ? { delivery } : {}),
    ...(access.kind === 'ready' ? { kind: access.content.kind, value: access.content.value } : {}),
  });
}
