// セッション破棄: KV のセッションレコードを削除し cookie を失効させる。
// cookie が無い/KV 未設定でも 200 (冪等)。
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { kvDel } from '@/lib/kv';
import { SESSION_COOKIE, sessionKey } from '@/lib/siwe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await kvDel(sessionKey(token));
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
