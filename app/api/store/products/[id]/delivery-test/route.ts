// GET /api/store/products/<id>/delivery-test — 出品者が、自分の商品の保護配布先からファイルを受け取れるかを、
// 購入せずに確かめる (2026-11-09 user: 高額商品でも毎回買って試すのは負担)。
// 購入者向けの /api/store/delivery/<id> と同じ 60 秒の署名付きチケットを出し、根拠 (basis) を 'seller' にする。
// - 出すのは商品の owner 本人 (SIWE) にだけ。他人の商品と存在しない商品は同じ 404 (存在を漏らさない)。
// - チケットの product はこの商品に固定される。配布先は product を固定して検証するので、他の商品の配布先を開ける
//   手段にはならない。出品者は自分のファイルを受け取るだけで、購入記録・在庫・NFT・権利の判定には触れない。
// - 公開前 (saleActive false) でも出す (公開前に確かめるための機能)。提供終了の商品は購入者と同じく 409。
// - 版は今新しく買う人が受け取る版: ライセンスは常に 1・普通の商品は今の版。前の版を買った人の版は確かめない
//   (購入者は買った版を受け取るので、配布先は前の版の対応も残す必要がある)。
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { kvIncr } from '@/lib/kv';
import { licenseVisible } from '@/lib/license/config';
import { isSameOriginGet } from '@/lib/net/crossOriginWrite';
import { deliveryFailurePage } from '@/lib/store/deliveryFailurePage';
import { deliveryTicketConfig, signDeliveryTicket } from '@/lib/store/deliveryTicket';
import { buildDeliveryRedirect, parseDeliveryUrl } from '@/lib/store/deliveryUrl';
import { getHostedProduct } from '@/lib/x402/hostedStore';
import { requireStoreSeller, storePrivateJson } from '@/app/api/store/_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'Vary': 'Cookie',
};
function error(code: string, status: number): NextResponse {
  return storePrivateJson({ ok: false, error: code }, status, PRIVATE_HEADERS);
}

// 第 10 回レビュー D-5: 発行の本体 (issue) は変えていない。GET は issue の応答を受け取り、失敗で、要求がブラウザの
// ナビゲーションのときだけ、同じ status の案内のページに差し替える。成功と、ナビゲーションでない要求への JSON は issue の応答そのまま。
export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  return deliveryFailurePage(req, await issue(req, context), 'seller');
}

async function issue(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!env.enableCreatorStore || !env.enableStoreDeliveryTicket) return error('not_found', 404);
  const auth = await requireStoreSeller(req, 'delivery');
  if (!auth.ok) {
    auth.response.headers.set('Referrer-Policy', 'no-referrer');
    return auth.response;
  }
  // 購入者向けと同じ: 別 site の画面から踏ませた GET で、出品者の cookie でチケットを出さない。
  if (!isSameOriginGet(req)) return error('cross_site', 403);
  // 購入者向けとチケットの発行数を共有する (1 つのウォレットで 1 分 20 枚まで)。
  const count = await kvIncr(`creator-store:delivery:ticket:${auth.address.toLowerCase()}`, { initialTtlSec: 60 });
  // 掟 13: 補助 rate-limit ストレージ障害を本体機能へ波及させない (counter のみ fail-open)。
  if (count.ok && count.value > 20) return error('rate_limited', 429);

  const { id } = await params;
  const product = await getHostedProduct(id);
  if (product === 'storage') return error('storage_unavailable', 503);
  if (!product || product.id !== id || !licenseVisible(product) ||
    product.owner.toLowerCase() !== auth.address.toLowerCase()) return error('not_found', 404);
  if (!product.contentAvailable) return error('provided_ended', 409);
  const destination = parseDeliveryUrl(product.deliveryUrl);
  if (!destination.ok) return error('delivery_not_configured', 409);
  if (!deliveryTicketConfig()) return error('delivery_unavailable', 503);

  const revision = product.productKind === 'license' ? 1 : product.contentRevision;
  const now = Math.floor(Date.now() / 1000);
  let ticket: string | null;
  try {
    ticket = signDeliveryTicket({
      audience: destination.origin, subject: auth.address, product: id, revision, basis: 'seller', now,
    });
  } catch {
    // 署名失敗を bearer/URL 付き例外として telemetry へ流さず、確認だけ unavailable にする。
    return error('delivery_unavailable', 503);
  }
  if (!ticket) return error('delivery_unavailable', 503);
  return new NextResponse(null, {
    status: 302, headers: { ...PRIVATE_HEADERS, Location: buildDeliveryRedirect(destination.url, ticket) },
  });
}
