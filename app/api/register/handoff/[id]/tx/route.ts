import type { NextResponse } from 'next/server';
import { STORE_HANDOFF_TOKEN_HEADER } from '@/lib/storeDevicePayment';
import { recordHandoffTx } from '@/lib/storeHandoff';
import { handoffDeps } from '@/lib/storeHandoffDeps';
import {
  handoffDisabled,
  handoffFailure,
  handoffJson,
  readHandoffBody,
} from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 10;

// お店の端末が送った tx を記録する (お客様の画面の完了表示を早める付帯情報・トークン必須)。
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  const parsed = await readHandoffBody(req);
  if (!parsed.ok) return parsed.res;
  const { id } = await params;
  const token = req.headers.get(STORE_HANDOFF_TOKEN_HEADER);
  const r = await recordHandoffTx(id, token, parsed.body, handoffDeps());
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
