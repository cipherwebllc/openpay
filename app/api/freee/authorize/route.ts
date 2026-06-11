// freee OAuth 認可開始。SIWE ログイン必須 → CSRF 用 state を KV に予約 → freee の
// 認可画面へ 302。returnTo (相対パスのみ) を state に同梱し callback 後に戻す。
import { NextResponse } from 'next/server';
import { isKvConfigured } from '@/lib/kv';
import { freeeEnv, buildAuthorizeUrl } from '@/lib/freee';
import { newSessionToken } from '@/lib/siwe';
import { env as appEnv } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { setState } from '../_store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<NextResponse> {
  // kill-switch: フラグ OFF の間は UI 非表示に加え API 自体も閉じる (直接 POST を防ぐ)
  if (!appEnv.enableFreeeSync) {
    return NextResponse.json({ ok: false, error: 'freee_disabled' }, { status: 503 });
  }
  // CSRF 緩和: 状態変更 (KV state 予約) を伴う GET。クロスサイト発のナビゲーションで
  // 踏まされないよう Sec-Fetch-Site: cross-site を拒否 (same-origin/same-site/none =
  // 自サイト遷移・直接入力のみ許可。ヘッダ未送出の旧ブラウザは SIWE セッション必須が
  // 引き続き下限の防御)。正規導線は FreeeSyncPanel の same-origin 遷移。
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return NextResponse.json({ ok: false, error: 'cross_site_request' }, { status: 403 });
  }
  if (!isKvConfigured()) {
    return NextResponse.json({ ok: false, error: 'kv_not_configured' }, { status: 503 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  // freee 連携は無料機能 (SIWE ログインのみ)。有料化は freee の有料アプリ要件
  // (掲載+Stripe+無料トライアル) を満たしてから別途。それまで利用権ゲートは設けない。
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
