import type { NextResponse } from 'next/server';
import { STORE_HANDOFF_TOKEN_HEADER } from '@/lib/storeDevicePayment';
import { closeHandoff } from '@/lib/storeHandoff';
import { handoffDeps } from '@/lib/storeHandoffDeps';
import { handoffDisabled, handoffFailure, handoffJson } from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 10;

// お店の端末が使わなくなったセッションを締め切る (QR の出し直し・別の会計・トークン必須)。
// 締め切る前に署名が入っていれば、それを返す (端末が受け取って送る)。本文は使わない。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  const { id } = await params;
  const token = req.headers.get(STORE_HANDOFF_TOKEN_HEADER);
  const r = await closeHandoff(id, token, handoffDeps());
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
