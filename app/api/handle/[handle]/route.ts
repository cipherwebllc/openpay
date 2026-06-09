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

export const runtime = 'nodejs';
export const maxDuration = 10;

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  if (!env.enableHandles) return notFound();
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
