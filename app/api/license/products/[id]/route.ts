import { NextResponse } from 'next/server';
import { listHandlesForOwner } from '@/lib/handleStore';
import { licenseNftEnabled } from '@/lib/license/config';
import { licenseSummariesFor } from '@/lib/license/display';
import { sellerRoleFor } from '@/lib/license/sellerRole';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import { storeProductPath } from '@/lib/storeProductLink';
import { getHostedProduct, isHostedId } from '@/lib/x402/hostedStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const error = (message: string, status: number) => NextResponse.json({ error: message }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (!licenseNftEnabled()) return error('not_found', 404);
  const { id } = await context.params;
  // 不正 ID は rate limit の KV を含む全 IO より前に拒否する。
  if (!isHostedId(id)) return error('invalid_input', 400);
  if (!await checkIpRateLimit('license-products', hashIp(clientIp(request)), 30, 60)) {
    const response = error('rate_limited', 429);
    response.headers.set('Retry-After', '60');
    return response;
  }
  const product = await getHostedProduct(id);
  if (product === 'storage') return error('storage_unavailable', 503);
  if (!product || product.id !== id || product.productKind !== 'license' || !product.license) return error('not_found', 404);
  // 販売停止・allowlist からの除外は既存ライセンスの識別情報を消さない。
  const handles = await listHandlesForOwner(product.owner);
  if (handles === null) return error('storage_unavailable', 503);
  const handle = product.handle && handles.includes(product.handle) ? product.handle : handles[0];
  if (!handle) return error('not_found', 404);
  let remaining: number | null = null;
  try {
    const summaries = await licenseSummariesFor([product]);
    remaining = summaries.get(id)!.remaining ?? null;
  } catch {
    // 在庫表示の障害を immutable な定義の解決へ波及させず、不明を null として返す。
  }
  const d = product.license;
  return NextResponse.json({
    version: 1, productId: id, chainId: d.tokenChainId, contract: d.contract, tokenId: d.tokenId,
    transferable: d.transferable, termsUrl: d.termsUrl, termsVersion: d.termsVersion,
    supply: d.supply, remaining, saleActive: product.saleActive,
    registered: product.registration?.status === 'registered',
    productUrl: 'https://open-pay.jp' + storeProductPath(handle, id),
    verifyUrl: 'https://open-pay.jp/api/license/verify?product=' + id,
    sellerRole: sellerRoleFor(product.owner),
  }, { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } });
}
