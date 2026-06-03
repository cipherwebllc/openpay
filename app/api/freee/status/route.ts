// freee 連携状態 (FreeeSyncPanel が表示の出し分けに使う)。SIWE 必須。
// API 呼び出しはせず KV のみ参照 (軽量・poll 可)。
import { NextResponse } from 'next/server';
import { requireSession } from '../../auth/siwe/_session';
import { getToken, getMeta, getMapping } from '../_store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await requireSession();
  if (!session.ok) return session.response;

  const [token, meta, mapping] = await Promise.all([
    getToken(session.address),
    getMeta(session.address),
    getMapping(session.address),
  ]);

  return NextResponse.json({
    ok: true,
    connected: !!token,
    companyId: meta?.companyId ?? token?.companyId ?? null,
    companyName: meta?.companyName ?? null,
    mappingSet: !!mapping,
  });
}
