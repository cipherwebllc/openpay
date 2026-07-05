// GET /api/agent-order/menu?h=<handle> — エージェント (MCP order_menu) が支払い前に @handle 店舗の
// **公開メニュー** を読む。鍵不要・公開データのみ (受取先/webhook/内部設定は返さない)。
//
// flag: enableX402Facilitator && enableOrderRelay && enableAgentOrder が全 true でなければ 404
// (agent-order は既存 x402 + 受注リレーの上に乗るため両基盤が必要)。storefront 無しは 404。
// money-path 非該当 (読み取りのみ)・既存 route は無改変 (追加のみ・掟12)。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { normalizeHandle, isValidHandleFormat } from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';

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

  const handle = normalizeHandle(new URL(req.url).searchParams.get('h') ?? '');
  if (!handle || !isValidHandleFormat(handle)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const resolved = await resolveHandle(handle);
  if (!resolved.ok) {
    return NextResponse.json({ error: 'kv_unavailable' }, { status: 503 });
  }
  const record = resolved.record;
  if (!record || !record.storefront) {
    return NextResponse.json({ error: 'no_storefront' }, { status: 404 });
  }

  const sf = record.storefront;
  // 表示名は storefront (ビルダー由来) 優先で @handle の name → @handle にフォールバック
  // (handleStorefrontConfig と同じ導出)。
  const shopName = sf.shopName || record.config.name?.trim() || `@${handle}`;
  const items = sf.menu.map((m) => ({
    id: m.id,
    name: m.name,
    price: m.price,
    ...(m.category ? { category: m.category } : {}),
    ...(m.recommended ? { recommended: true } : {}),
    // options 付き item は order_quote で拒否されるため、エージェントが事前に避けられるよう明示する。
    hasOptions: Boolean(m.options && m.options.length > 0),
  }));

  return NextResponse.json({
    handle,
    shopName,
    mode: sf.mode,
    chain: sf.chain,
    items,
  });
}
