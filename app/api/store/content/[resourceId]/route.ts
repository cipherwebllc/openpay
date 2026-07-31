import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import {
  getHostedContent,
  getHostedProduct,
} from '@/lib/x402/hostedStore';
import {
  readStoreOwnership,
  selectStorePurchaseGrant,
} from '@/lib/x402/storeEntitlement';
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

type ContentSelector = {
  revision: number | null;
  intentSalt: string | null;
};

const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const CANONICAL_INTENT_SALT_RE = /^0x[0-9a-f]{64}$/;

function contentSelector(req: Request): ContentSelector | null {
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
  // 商品/content の存在を先に見ると、未所有者へ resource の存在を漏らすため own が先。
  const owned = await readStoreOwnership(auth.address, resourceId);
  if (!owned.ok) return storageUnavailable();
  if (!owned.ownership) return notFound();

  const grant = selectStorePurchaseGrant(owned.ownership, selector);
  // 未所有 resource と、所有 record 内に指定 grant がない場合は同じ oracle-safe 404。
  if (!grant) return notFound();
  const product = await getHostedProduct(resourceId);
  if (product === 'storage') return storageUnavailable();
  // 未所有と商品レコード不在は、body/status とも同一の 404 にする。
  if (!product) return notFound();
  if (product.id !== resourceId) {
    // key と embedded id の破損から、別商品の availability を権利判定へ波及させない。
    return storageUnavailable();
  }
  if (!product.contentAvailable) {
    return storePrivateJson({
      ok: true,
      state: 'provided-ended',
      resourceId,
      title: grant.metadata.title,
      contentRevision: grant.contentRevision,
      intentSalt: grant.intentSalt,
      purchasedAt: grant.purchasedAt,
      txHash: grant.txHash,
    });
  }

  const content = await getHostedContent(
    resourceId,
    grant.contentRevision,
  );
  if (content === 'storage') return storageUnavailable();
  if (!content) {
    return storePrivateJson({
      ok: true,
      state: 'provided-ended',
      resourceId,
      title: grant.metadata.title,
      contentRevision: grant.contentRevision,
      intentSalt: grant.intentSalt,
      purchasedAt: grant.purchasedAt,
      txHash: grant.txHash,
    });
  }
  if (content.kind !== grant.metadata.contentKind) {
    // 購入時 metadata と本文種別の不整合時に、別形式の本文を配信する偽成功を防ぐ。
    return storageUnavailable();
  }
  // 来歴 (誰宛の提供か) の明示用 (2026-08-01 user 裁定: 二次流通対策は
  // 「表示による抑止 + 購入記録との突き合わせ根拠」に限定し、ファイル埋め込みはしない)。
  return storePrivateJson({
    ok: true,
    state: 'ready',
    resourceId,
    title: grant.metadata.title,
    contentRevision: grant.contentRevision,
    intentSalt: grant.intentSalt,
    purchasedAt: grant.purchasedAt,
    txHash: grant.txHash,
    kind: content.kind,
    value: content.value,
  });
}
