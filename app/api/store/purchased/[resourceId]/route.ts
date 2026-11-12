import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { readStoreOwnership } from '@/lib/x402/storeEntitlement';
import {
  requireStoreSeller,
  storePrivateJson,
} from '@/app/api/store/_shared';

// 購入の画面が「このウォレットはこの商品を購入済みか」だけを確かめる route (第 10 回レビュー H-K・Codex P2-2)。
// 確認の段 (components/CreatorStorePurchaseFlow) は購入画面を開くたび・見積もりごとに読む。商品の本文を返す
// /api/store/content/{id} を使うと、その読み取りがライブラリの商品の読み取りと購入の直後の読み戻しの
// rate limit の枠を食うので、枠を分けたこの route を足した。
//
// - 返すのは購入の記録 (grant) の有無と最新の購入日時だけ。本文・配布先・intentSalt・txHash は返さない。
// - 読むのはこのウォレットの購入の記録の key 1 つだけ (store:own:<address>:<id>)。商品・本文・権利の確認の RPC は
//   読まない: 譲渡で license を持っているだけ (購入の記録が無い) は false、購入した license を譲った後も true
//   (購入の記録は残る。確認の段は「購入した記録がある」という事実だけを言う)。
// - rate limit は content と別の名前の枠 (creator-store:purchased)。枠の大きさ・storage 障害で通す (fail-open) の
//   扱いは Store の他の route と同じ (app/api/store/_shared.ts)。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ resourceId: string }>;
};

export async function GET(
  req: Request,
  { params }: RouteContext,
): Promise<NextResponse> {
  if (!env.enableCreatorStore) {
    return storePrivateJson({ ok: false, error: 'not_found' }, 404);
  }
  const auth = await requireStoreSeller(req, 'purchased');
  if (!auth.ok) return auth.response;

  const { resourceId } = await params;
  const owned = await readStoreOwnership(auth.address, resourceId);
  if (!owned.ok) {
    return storePrivateJson(
      { ok: false, error: 'storage_unavailable' },
      503,
    );
  }
  if (!owned.ownership) {
    return storePrivateJson({ ok: true, purchased: false });
  }
  return storePrivateJson({
    ok: true,
    purchased: true,
    purchasedAt: owned.ownership.latestGrant.purchasedAt,
  });
}
