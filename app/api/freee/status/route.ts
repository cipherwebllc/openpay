// freee 連携状態 (FreeeSyncPanel が表示の出し分けに使う)。SIWE 必須。
// API 呼び出しはせず KV のみ参照 (軽量・poll 可)。
import { NextResponse } from 'next/server';
import { env as appEnv } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { getToken, getMeta, getMapping } from '../_store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // kill-switch: フラグ OFF の間は UI 非表示に加え API 自体も閉じる (直接 POST を防ぐ)
  if (!appEnv.enableFreeeSync) {
    return NextResponse.json({ ok: false, error: 'freee_disabled' }, { status: 503 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  const [token, meta, mapping] = await Promise.all([
    getToken(session.address),
    getMeta(session.address),
    getMapping(session.address),
  ]);

  // セッション (店主ウォレット) 固有の連携状態 → 共有キャッシュに載せない。
  return NextResponse.json(
    {
      ok: true,
      connected: !!token,
      companyId: meta?.companyId ?? token?.companyId ?? null,
      companyName: meta?.companyName ?? null,
      mappingSet: !!mapping,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
