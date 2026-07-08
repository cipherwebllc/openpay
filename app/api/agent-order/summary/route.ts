// GET /api/agent-order/summary?h=&cart=&table=&pickupAt= — エージェント (MCP order_summary) が
// **人払い (createOrderLink → @handle?cart= checkout)** の金額を支払い前に読むための **読み取り専用**
// 内訳。鍵不要・公開データのみ (受取先/webhook/内部設定は返さない)・**支払いは一切発生しない**。
//
// なぜ order_quote (x402) と別経路か: order_quote は AI 自動決済 (x402) 用で買い手上乗せ
// (maxAmountRequired = merchant + fee・フロア 1 JPYC) を返すため、人払い checkout の実額
// (store-borne = 客は小計ちょうど・店が 1% を吸収) と食い違う。ここは人払いの実額に一致させる。
//
// 手数料は lib/mobileOrderFee (storefront = 1%・フロア無し・常に店舗負担) で計算する。
// ⚠️ lib/x402 の x402FeeValue (フロア 1 JPYC) は **使わない** — @handle 店頭 (storefront) の
// 人払い checkout と同じ料率にするため。Part A は storefront (店頭・店舗負担) に scope を限定する
// (preorder 3%/顧客上乗せの写像は別 issue・plans/agent-order-fee-consistency.md H3)。
//
// flag: enableX402Facilitator && enableOrderRelay && enableAgentOrder が全 true でなければ 404
// (menu route と同型)。**money-path 非該当** (読み取りのみ・facilitator/relay/settle には一切触れない
// = 追加のみ・掟12)。金額は menu route と同じく KV 権威の storefront から server 再解決する。

import { NextResponse } from 'next/server';
import { formatUnits } from 'viem';
import { env } from '@/lib/env';
import { normalizeHandle, isValidHandleFormat } from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import { chainForSlug } from '@/lib/chains';
import { resolveDeployment } from '@/lib/tokens';
import { decodeAgentCart, computeAgentOrder } from '@/lib/agentOrder';
import { mobileOrderBreakdown } from '@/lib/mobileOrderFee';
import { declaredItemsTotalMinor } from '@/lib/orderRelay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function agentOrderEnabled(): boolean {
  return (
    env.enableX402Facilitator && env.enableOrderRelay && env.enableAgentOrder
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!agentOrderEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const url = new URL(req.url);
  const handle = normalizeHandle(url.searchParams.get('h') ?? '');
  if (!handle || !isValidHandleFormat(handle)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // table / pickupAt は金額に影響しない (注文メタデータ)。createOrderLink とツール引数を揃えるため
  // 受理はするが、内訳計算には使わない (支払い実額は小計 + storefront 手数料だけで決まる)。
  const cartParam = url.searchParams.get('cart') ?? '';
  const cartItems = decodeAgentCart(cartParam);
  if (cartItems === null) {
    return NextResponse.json({ error: 'invalid_cart' }, { status: 422 });
  }

  const resolved = await resolveHandle(handle);
  if (!resolved.ok) {
    return NextResponse.json({ error: 'kv_unavailable' }, { status: 503 });
  }
  const record = resolved.record;
  if (!record || !record.storefront) {
    return NextResponse.json({ error: 'no_storefront' }, { status: 404 });
  }

  // 小計 (minor units) を出すために decimals が要る。storefront.chain の JPYC deployment から取得する
  // (pay route と同じ導出)。deployment が無い = 未対応チェーン → 422 (silent に 0 化しない)。
  // ⚠️ forwarder は要求しない — 読み取り専用で settle しないため (money-path 非該当)。
  const chainId = chainForSlug(record.storefront.chain).id;
  const deployment = resolveDeployment('jpyc', chainId);
  if (!deployment) {
    return NextResponse.json({ error: 'unsupported_chain' }, { status: 422 });
  }
  const { decimals } = deployment;

  const order = computeAgentOrder(record.storefront, cartItems, decimals);
  if (!order.ok) {
    return NextResponse.json({ error: order.reason }, { status: 422 });
  }

  // 人払い = store-borne: 客は小計ちょうど・店が手数料を吸収。分割は mobileOrderBreakdown が単一情報源
  // (storefront は feePayer によらず常に merchant 負担)。フロア無し 1% は mobileOrderFeeValue 準拠。
  const breakdown = mobileOrderBreakdown(order.totalMinor, 'storefront', 'merchant');

  const shopName =
    record.storefront.shopName || record.config.name?.trim() || `@${handle}`;

  // 明細の行合計 (minor) は declaredItemsTotalMinor を 1 行ずつ再利用して求める (合計と同一算術)。
  const items = order.items.map((it) => ({
    name: it.name,
    qty: it.qty,
    unitPriceJpyc: it.price,
    lineJpyc: formatUnits(declaredItemsTotalMinor([it], decimals) ?? 0n, decimals),
  }));

  return NextResponse.json({
    handle,
    shopName,
    chain: record.storefront.chain,
    currency: 'JPYC',
    items,
    subtotalJpyc: formatUnits(order.totalMinor, decimals),
    feeJpyc: formatUnits(breakdown.feeAmount, decimals),
    feeBearer: 'merchant', // storefront は常に店舗負担 (客は小計ちょうど)
    customerPaysJpyc: formatUnits(breakdown.customerPays, decimals),
  });
}
