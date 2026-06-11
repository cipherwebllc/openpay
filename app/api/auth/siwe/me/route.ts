// 現在の SIWE セッション状態。client (useSiweSession) が初期化時とサインイン後に叩く。
// 未ログイン/失効は address:null (200) を返す — 401 にしないのは「ログインしていない」も
// 正常状態だから (client は address の有無だけ見る)。
import { NextResponse } from 'next/server';
import { getSessionAddress } from '../_session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const address = await getSessionAddress();
  return NextResponse.json(
    { ok: true, address },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
