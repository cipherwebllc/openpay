import { NextResponse } from 'next/server';
import { listHandlesForOwner } from '@/lib/handleStore';
import { licenseNftEnabled } from '@/lib/license/config';
import { storeProductPath } from '@/lib/storeProductLink';
import { getHostedProduct, isHostedId } from '@/lib/x402/hostedStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const error = (message: string, status: number) => NextResponse.json({ error: message }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (!licenseNftEnabled()) return error('not_found', 404);
  const { id } = await context.params;
  if (!isHostedId(id)) return error('not_found', 404);
  // descriptor と同じ product/owner handle 解決。metadata は登録済みだけを公開する。
  const product = await getHostedProduct(id);
  if (product === 'storage') return error('storage_unavailable', 503);
  if (!product || product.id !== id || product.productKind !== 'license' || !product.license ||
      product.registration?.status !== 'registered') return error('not_found', 404);
  const handles = await listHandlesForOwner(product.owner);
  if (handles === null) return error('storage_unavailable', 503);
  const handle = product.handle && handles.includes(product.handle) ? product.handle : handles[0];
  if (!handle) return error('not_found', 404);
  const d = product.license;
  // imageUrl は hostedStore の読込で HTTPS URL として検証済み。
  const image = product.imageUrl?.startsWith('https://') ? product.imageUrl
    : 'https://open-pay.jp/og/handle?h=' + encodeURIComponent(handle) + '&locale=ja';
  return NextResponse.json({
    name: product.title,
    description: (product.desc ? product.desc + '\n' : '') + `利用条件: ${d.termsUrl} (${d.termsVersion})`,
    image,
    external_url: 'https://open-pay.jp' + storeProductPath(handle, id),
    attributes: [
      { trait_type: 'Transferable', value: d.transferable ? 'yes' : 'no' },
      { trait_type: 'Terms version', value: d.termsVersion },
      { trait_type: 'Terms URL', value: d.termsUrl },
      { trait_type: 'Chain', value: d.tokenChainId === 80002 ? 'Polygon Amoy' : 'Polygon' },
      { trait_type: 'Supply', value: d.supply },
    ],
  }, { headers: { 'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' } });
}
