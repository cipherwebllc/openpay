import type { NextResponse } from 'next/server';
import { STORE_HANDOFF_TOKEN_HEADER } from '@/lib/storeDevicePayment';
import { readHandoff } from '@/lib/storeHandoff';
import { handoffDeps } from '@/lib/storeHandoffDeps';
import { handoffDisabled, handoffFailure, handoffJson } from '@/lib/storeHandoffRoute';

export const runtime = 'nodejs';
export const maxDuration = 10;

// 受け渡しの状態。トークン (ヘッダ) なし = お客様向けの公開項目だけ、あり = お店の端末向けに署名まで。
// 端末の読み取りは間隔をあけて繰り返すので KV の rate limit は付けない (1 読みのコマンド数を増やさない)。
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const disabled = handoffDisabled();
  if (disabled) return disabled;
  const { id } = await params;
  const token = req.headers.get(STORE_HANDOFF_TOKEN_HEADER);
  const r = await readHandoff(id, token, handoffDeps());
  return r.ok ? handoffJson(r) : handoffFailure(r);
}
