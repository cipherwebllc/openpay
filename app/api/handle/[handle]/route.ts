// @handle 個別 API。NEXT_PUBLIC_ENABLE_HANDLES OFF で 404 (inert)。
//
// GET    /api/handle/{handle}  → 予約可否 (public・dashboard の即時チェック用)
// DELETE /api/handle/{handle}  → 解放 (SIWE・所有者のみ)

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { isKvConfigured } from '@/lib/kv';
import { requireSession } from '../../auth/siwe/_session';
import { validateHandle } from '@/lib/handle';
import { resolveHandle, releaseHandle } from '@/lib/handleStore';
import { checkReadRateLimit } from '@/lib/relay/relayGuards';
import { anonymizeIp } from '@/lib/relay/relayRoute';

export const runtime = 'nodejs';
export const maxDuration = 10;

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  if (!env.enableHandles) return notFound();
  // IP 固定窓 (公開・無認証の予約可否 read)。@handle 空間の総当り列挙と、それによる KV read
  // 圧力が予約/公開の本体機能へ波及するのを入口で止める。dashboard の入力中チェック
  // (1 handle あたり数回) の遥か上の上限。
  const ipPrefix = anonymizeIp(
    req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? '',
  );
  if (!(await checkReadRateLimit(`handleavail:${ipPrefix}`, 60, 60))) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      { status: 429 },
    );
  }
  const { handle: raw } = await params;
  const validated = validateHandle(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: true, available: false, reason: validated.reason });
  }
  if (!isKvConfigured()) {
    return NextResponse.json({ ok: true, available: false, reason: 'unavailable' });
  }
  const resolved = await resolveHandle(validated.handle);
  if (!resolved.ok) {
    // KV エラーは「空き」と誤答せず unavailable を返す (outage 中の誤予約防止)。
    return NextResponse.json({ ok: true, available: false, reason: 'unavailable' });
  }
  return NextResponse.json({
    ok: true,
    available: resolved.record === null,
    reason: resolved.record ? 'taken' : undefined,
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  if (!env.enableHandles) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  const { handle: raw } = await params;
  const validated = validateHandle(raw);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, error: 'invalid_format' }, { status: 400 });
  }
  const status = await releaseHandle({
    handle: validated.handle,
    owner: session.address,
  });
  switch (status) {
    case 'released':
      return NextResponse.json({ ok: true });
    case 'not_found':
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    case 'forbidden':
      return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    case 'kv_unavailable':
      return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
    case 'kv_error':
    default:
      return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 502 });
  }
}
