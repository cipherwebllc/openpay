// POST /api/order/admission — @handle モバイル注文の署名前 admission 再検証。
//
// 公開ページで計算した受付状態は時間経過や storefront 更新で stale になり得る。不可逆な wallet
// 署名へ進む直前に、server 時刻と最新 KV storefront から受付状態・preorder スロットを再計算する。
// MobileOrderView の CTA と CheckoutForm の submit が同じ API を使うため、CTA だけに依存しない。

import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { env } from '@/lib/env';
import { isValidHandleFormat, normalizeHandle } from '@/lib/handle';
import { resolveHandle } from '@/lib/handleStore';
import type { MobileOrderMode } from '@/lib/mobileOrder';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';
import { isBeforeOpen, isPastLastOrder, pickupSlots } from '@/lib/shopTime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AdmissionBody = {
  handle: string;
  merchant: string;
  mode: MobileOrderMode;
  pickupAt?: number;
};

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function parseBody(value: unknown): AdmissionBody | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.handle !== 'string' ||
    typeof raw.merchant !== 'string' ||
    !isAddress(raw.merchant) ||
    (raw.mode !== 'storefront' && raw.mode !== 'preorder')
  ) {
    return null;
  }
  if (
    raw.pickupAt !== undefined &&
    (typeof raw.pickupAt !== 'number' ||
      !Number.isSafeInteger(raw.pickupAt) ||
      raw.pickupAt <= 0)
  ) {
    return null;
  }
  return {
    handle: raw.handle,
    merchant: raw.merchant,
    mode: raw.mode,
    ...(raw.pickupAt !== undefined ? { pickupAt: raw.pickupAt } : {}),
  };
}

export async function POST(req: Request): Promise<NextResponse> {
  // kill-switch: flag OFF の間は UI 非表示に加え API 自体も閉じる (直接 POST を防ぐ)。
  if (!env.enableMobileOrder) return json({ ok: false, error: 'not_found' }, 404);

  // IP 固定窓 (公開・無認証の handle 解決を伴う endpoint)。単一 IP の flood が KV read を
  // 押し上げて正規の注文導線に波及するのを、body 解析と KV 参照の前で止める。上限は正当な
  // CTA/submit (数回/注文) の遥か上に置く (/api/order/status と同じ 120/分)。
  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );
  if (!(await checkReadRateLimit(`admission:${ipPrefix}`, 120, 60))) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const body = parseBody(raw);
  if (!body) return json({ ok: false, error: 'invalid_request' }, 400);

  const handle = normalizeHandle(body.handle);
  if (!handle || !isValidHandleFormat(handle)) {
    return json({ ok: false, error: 'invalid_handle' }, 400);
  }

  const resolved = await resolveHandle(handle);
  if (!resolved.ok) {
    return json({ ok: false, error: 'kv_unavailable' }, 503);
  }
  const record = resolved.record;
  if (!record?.storefront) {
    return json({ ok: false, error: 'storefront_not_found' }, 404);
  }

  let latestMerchant: string;
  try {
    latestMerchant = getAddress(record.config.to);
  } catch {
    return json({ ok: false, error: 'storefront_not_found' }, 404);
  }
  // attacker が受付中の別 handle を指定し、停止中店舗への不可逆決済へ進む波及を断つ。
  if (latestMerchant !== getAddress(body.merchant)) {
    return json({ ok: false, error: 'storefront_changed' }, 409);
  }

  const storefront = record.storefront;
  if (storefront.mode !== body.mode) {
    return json({ ok: false, error: 'storefront_changed' }, 409);
  }
  if (storefront.acceptingOrders === false) {
    return json({ ok: false, error: 'store_not_accepting' }, 409);
  }

  if (!env.enablePreorderTime) {
    return json({ ok: true }, 200);
  }

  const now = Date.now();
  if (
    isBeforeOpen(now, storefront.openFrom) ||
    isPastLastOrder(now, storefront.lastOrder)
  ) {
    return json({ ok: false, error: 'store_not_accepting' }, 409);
  }

  if (body.mode === 'preorder') {
    const slots = pickupSlots(
      now,
      storefront.minLeadMinutes,
      storefront.lastOrder,
    );
    if (slots.length === 0) {
      return json({ ok: false, error: 'pickup_slots_unavailable' }, 409);
    }
    if (body.pickupAt !== undefined && !slots.includes(body.pickupAt)) {
      return json({ ok: false, error: 'pickup_slot_unavailable' }, 409);
    }
  }

  return json({ ok: true }, 200);
}
