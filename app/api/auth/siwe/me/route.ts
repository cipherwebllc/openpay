// 現在の SIWE セッション状態。client (useSiweSession) が初期化時とサインイン後に叩く。
// 未ログイン/失効は address:null (200) を返す — 401 にしないのは「ログインしていない」も
// 正常状態だから。KV 読取障害だけは未ログインと混同せず 503 にする。
//
// 画像のアップロード (IMAGE_UPLOAD_MODE) の 2 つの値は true のときだけ足す (off では応答は今と同じ形)。env を読むだけで、
// KV と Blob には触れない (この GET の呼び出しと KV の op は増えない):
// - imageUpload: セッションの本人が画像のアップロード・一覧・削除を使える (imageUploadAvailableFor)。
// - imageUploadSignIn: サインインすると画像の機能を使えるかもしれない (段階が admin / all で設定がそろっている)。
//   ヘッダのサインインの導線 (WalletBadge の siweEnabled・掟 7) と、/me/images の「サインインする」に使う。
import { NextResponse } from 'next/server';
import { imageUploadAvailableFor, imageUploadSignInOffered } from '@/lib/images/config';
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
  const address = session.status === 'authenticated' ? session.address : null;
  return NextResponse.json(
    {
      ok: true,
      address,
      ...(address !== null && imageUploadAvailableFor(address) ? { imageUpload: true } : {}),
      ...(imageUploadSignInOffered() ? { imageUploadSignIn: true } : {}),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
