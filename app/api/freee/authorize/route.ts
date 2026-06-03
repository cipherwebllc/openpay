// freee OAuth 認可開始。SIWE ログイン必須 → CSRF 用 state を KV に予約 → freee の
// 認可画面へ 302。returnTo (相対パスのみ) を state に同梱し callback 後に戻す。
import { NextResponse } from 'next/server';
import { isKvConfigured } from '@/lib/kv';
import { freeeEnv, buildAuthorizeUrl } from '@/lib/freee';
import { newSessionToken } from '@/lib/siwe';
import { isEntitled } from '@/lib/entitlement';
import { requireSession } from '../../auth/siwe/_session';
import { setState } from '../_store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  if (!isKvConfigured()) {
    return NextResponse.json({ ok: false, error: 'kv_not_configured' }, { status: 503 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  // 収益化ゲート (アルファ中は bypass で全通過)。
  if (!(await isEntitled(session.address))) {
    return NextResponse.json({ ok: false, error: 'entitlement_required' }, { status: 402 });
  }

  const env = freeeEnv();
  if (!env) {
    return NextResponse.json({ ok: false, error: 'freee_not_configured' }, { status: 503 });
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get('returnTo') ?? '/';
  // open-redirect 防止: 同一オリジン相対パスのみ許可 ('//evil' も弾く)。
  const returnTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

  const state = newSessionToken();
  const reserved = await setState(state, { wallet: session.address, returnTo });
  if (!reserved) {
    return NextResponse.json({ ok: false, error: 'state_failed' }, { status: 503 });
  }
  return NextResponse.redirect(buildAuthorizeUrl(env, state), 302);
}
