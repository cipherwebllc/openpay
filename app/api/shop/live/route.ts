// 店舗のライブ運用状態 (売り切れ / 受付一時停止) API。
//   GET   ?h=<handle> → 公開読取 (顧客ページ/店主パネル両用・認証不要)。
//   PATCH ?h=<handle> → 店主のみ (SIWE + handle 所有者照合)。単一操作 (ShopLivePatch) を CAS で適用。
// flag NEXT_PUBLIC_ENABLE_SHOP_LIVE OFF で 404 (inert)。所有者不一致は 403・KV 障害は 503・競合は 409。
// 設計: plans/restaurant-pos-roadmap.md §3-A。
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { resolveHandle } from '@/lib/handleStore';
import { normalizeHandle } from '@/lib/handle';
import { parseShopLivePatch } from '@/lib/shopLive';
import { readShopLive, applyShopLive } from '@/lib/shopLiveStore';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}

// handle は URL query (?h=) で受ける (notify ルートと同じ流儀)。normalizeHandle で @/大小を正規化。
function handleFromReq(req: Request): string {
  return normalizeHandle(new URL(req.url).searchParams.get('h') ?? '');
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!env.enableShopLive) return notFound();
  const handle = handleFromReq(req);
  if (!handle) return NextResponse.json({ ok: false, error: 'handle_required' }, { status: 400 });
  // 読取は fail-open (readShopLive が KV 障害時 EMPTY を返す)。公開情報なので認証不要。
  const live = await readShopLive(handle);
  return NextResponse.json({ ok: true, live });
}

export async function PATCH(req: Request): Promise<NextResponse> {
  if (!env.enableShopLive) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  const handle = handleFromReq(req);
  if (!handle) return NextResponse.json({ ok: false, error: 'handle_required' }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const patch = parseShopLivePatch(body);
  if (!patch) return NextResponse.json({ ok: false, error: 'invalid_patch' }, { status: 400 });

  // 所有者照合: handle の owner === サインイン中ウォレットのみ操作可 (他人の店舗を改変させない)。
  const resolved = await resolveHandle(handle);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
  }
  if (!resolved.record) {
    return NextResponse.json({ ok: false, error: 'handle_not_found' }, { status: 404 });
  }
  if (resolved.record.owner.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const res = await applyShopLive(handle, patch, Date.now());
  if (!res.ok) {
    logger.warn('shop.live.patch_failed', { handle, reason: res.reason });
    return NextResponse.json(
      { ok: false, error: res.reason },
      { status: res.reason === 'conflict' ? 409 : 503 },
    );
  }
  return NextResponse.json({ ok: true, live: res.state });
}
