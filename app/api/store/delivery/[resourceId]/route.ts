import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { kvIncr } from '@/lib/kv';
import { licenseNftEnabled } from '@/lib/license/config';
import { acquireDeliveryBudget, releaseDeliveryBudget } from '@/lib/store/deliveryBudget';
import { DELIVERY_TICKET_TTL_SECONDS, deliveryTicketConfig, signDeliveryTicket } from '@/lib/store/deliveryTicket';
import { buildDeliveryRedirect, parseDeliveryUrl } from '@/lib/store/deliveryUrl';
import { isHostedId } from '@/lib/x402/hostedStore';
import { parseStoreContentSelector, resolveStoreContentAccess } from '@/lib/x402/storeContentAccess';
import { requireStoreSeller, storePrivateJson } from '@/app/api/store/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'Vary': 'Cookie',
};
function error(code: string, status: number): NextResponse {
  return storePrivateJson({ ok: false, error: code }, status, PRIVATE_HEADERS);
}

export async function GET(req: Request, { params }: { params: Promise<{ resourceId: string }> }): Promise<NextResponse> {
  if (!env.enableCreatorStore || !env.enableStoreDeliveryTicket) return error('not_found', 404);
  const auth = await requireStoreSeller(req, 'delivery');
  if (!auth.ok) {
    auth.response.headers.set('Referrer-Policy', 'no-referrer');
    return auth.response;
  }
  if (req.headers.get('Sec-Fetch-Site') === 'cross-site') return error('cross_site', 403);
  const selector = parseStoreContentSelector(req);
  if (!selector) return error('invalid_selector', 400);
  const formats = new URL(req.url).searchParams.getAll('format');
  if (formats.length > 1 || (formats.length === 1 && formats[0] !== 'json')) return error('invalid_format', 400);

  const count = await kvIncr(`creator-store:delivery:ticket:${auth.address.toLowerCase()}`, { initialTtlSec: 60 });
  // 掟 13: 補助 rate-limit ストレージ障害を本体機能へ波及させない (counter のみ fail-open)。
  if (count.ok && count.value > 20) return error('rate_limited', 429);
  const { resourceId } = await params;
  // license grant parser と holder 経路は revision=1 に固定されているため、明示 revision>1
  // は RPC に進まない。それ以外の hosted id は商品/ownership を重複読込せず保守的に admission。
  let lease: string | null = null;
  if (licenseNftEnabled() && isHostedId(resourceId) && (selector.revision === null || selector.revision === 1)) {
    lease = await acquireDeliveryBudget();
    if (!lease) return error('delivery_unavailable', 503);
  }
  try {
    const access = await resolveStoreContentAccess({ address: auth.address, resourceId, selector });
    if (access.kind === 'denied') return error('not_found', 404);
    if (access.kind === 'storage') return error('storage_unavailable', 503);
    if (access.kind === 'rights_unknown') return error('license_rights_unknown', 503);
    if (access.kind === 'ended') return error('provided_ended', 409);
    const destination = parseDeliveryUrl(access.product.deliveryUrl);
    if (!destination.ok) return error('delivery_not_configured', 409);
    const revision = access.source === 'purchase' ? access.grant.contentRevision : 1;
    if (!deliveryTicketConfig()) return error('delivery_unavailable', 503);
    const now = Math.floor(Date.now() / 1000);
    let ticket: string | null;
    try {
      ticket = signDeliveryTicket({
        audience: destination.origin, subject: auth.address, product: resourceId, revision,
        basis: access.rights?.basis ?? 'purchase', now,
      });
    } catch {
      // 署名失敗を bearer/URL 付き例外として telemetry へ流さず、配布だけ unavailable にする。
      return error('delivery_unavailable', 503);
    }
    if (!ticket) return error('delivery_unavailable', 503);
    const url = buildDeliveryRedirect(destination.url, ticket);
    if (formats.length === 1) {
      return storePrivateJson({
        ok: true, url, ticket, expiresAt: new Date((now + DELIVERY_TICKET_TTL_SECONDS) * 1000).toISOString(),
        audience: destination.origin, product: resourceId, revision,
      }, 200, PRIVATE_HEADERS);
    }
    return new NextResponse(null, { status: 302, headers: { ...PRIVATE_HEADERS, Location: url } });
  } finally {
    if (lease) await releaseDeliveryBudget(lease);
  }
}
