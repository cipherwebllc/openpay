// 現在の SIWE セッション状態。client (useSiweSession) が初期化時とサインイン後に叩く。
// 未ログイン/失効は address:null (200) を返す — 401 にしないのは「ログインしていない」も
// 正常状態だから。KV 読取障害だけは未ログインと混同せず 503 にする。
import { NextResponse } from 'next/server';
import { readSession } from '../_session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await readSession();
  if (session.status === 'storage-error') {
    return NextResponse.json(
      { ok: false, error: 'session_storage_unavailable' },
      {
        status: 503,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  }
  return NextResponse.json(
    {
      ok: true,
      address: session.status === 'authenticated' ? session.address : null,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
