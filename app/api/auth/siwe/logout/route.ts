// セッション破棄: KV のセッションレコードを削除し cookie を失効させる。
// cookie が無い/セッションが既に無ければ 200 (冪等)。KV 障害時も露出縮小のため cookie は失効させるが、
// サーバ側セッションの削除を確認できないので成功とは返さない。
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { kvDel } from '@/lib/kv';
import { sessionCookieName, sessionKey } from '@/lib/siwe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const cookieName = sessionCookieName();
  const token = store.get(cookieName)?.value;
  let revoked = true;
  if (token) {
    const del = await kvDel(sessionKey(token));
    // value=0 は既に削除済み/未設定の正常系。KV コマンドの成否は ok で判定する。
    revoked = del.ok;
  }
  const res = revoked
    ? NextResponse.json({ ok: true })
    : NextResponse.json(
        { ok: false, error: 'session_revoke_failed' },
        { status: 503 },
      );
  // 失効も発行と同じ属性で出す (`__Host-` は Secure + Path=/ + Domain 無しが受理条件)。
  res.cookies.set(cookieName, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
