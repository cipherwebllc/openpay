// freee OAuth コールバック。state を検証 (1 回限り消費 + 現セッション wallet と一致 = CSRF
// 防御) → code を token 交換 → company 確定 → token/meta を KV 保存 → returnTo へ戻す。
import { NextResponse } from 'next/server';
import { freeeEnv, exchangeCode, getCompanies } from '@/lib/freee';
import { logger } from '@/lib/logger';
import { env as appEnv } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { consumeState, setToken, setMeta, getMeta, delMapping } from '../_store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorRedirect(req: Request, reason: string): NextResponse {
  const dest = new URL('/', req.url);
  dest.searchParams.set('freee', 'error');
  dest.searchParams.set('reason', reason);
  return NextResponse.redirect(dest);
}

export async function GET(req: Request): Promise<NextResponse> {
  // kill-switch: フラグ OFF の間は UI 非表示に加え API 自体も閉じる (直接 POST を防ぐ)
  if (!appEnv.enableFreeeSync) return errorRedirect(req, 'disabled');
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const denied = url.searchParams.get('error');

  if (denied) return errorRedirect(req, 'denied');
  if (!code || !state) return errorRedirect(req, 'missing_params');

  const stateValue = await consumeState(state);
  if (!stateValue) return errorRedirect(req, 'invalid_state');

  // CSRF: callback を踏んだブラウザの SIWE セッションが state 発行 wallet と一致すること。
  const session = await requireSession();
  if (!session.ok || session.address.toLowerCase() !== stateValue.wallet.toLowerCase()) {
    return errorRedirect(req, 'session_mismatch');
  }

  const env = freeeEnv();
  if (!env) return errorRedirect(req, 'not_configured');

  // freee 側の失敗 (token 交換不可・API エラー・想定外レスポンス) は生 500 ではなく
  // returnTo への graceful な errorRedirect に倒す (ユーザはホームへ戻り再試行できる)。
  try {
    let token = await exchangeCode(env, code);
    const companies = await getCompanies(token.access);
    const companyId = token.companyId ?? companies[0]?.id ?? null;
    const companyName =
      companies.find((c) => c.id === companyId)?.name ??
      (companyId != null ? String(companyId) : '');

    // 別会社(事業所)に再連携した場合、旧会社の勘定科目/税区分を指す mapping は無効なので破棄し
    // 再マッピングを促す (status.mappingSet=false に倒れパネルが mapping editor を出す)。
    const prevMeta = await getMeta(stateValue.wallet);
    if (prevMeta && prevMeta.companyId !== companyId) {
      await delMapping(stateValue.wallet);
    }

    if (companyId == null) {
      logger.warn('freee.callback.no-company', { wallet: stateValue.wallet });
      return errorRedirect(req, 'no_company');
    }
    token = { ...token, companyId };
    await setToken(stateValue.wallet, token);
    await setMeta(stateValue.wallet, { companyId, companyName });
  } catch (e) {
    logger.warn('freee.callback.token_exchange_failed', {
      reason: e instanceof Error ? e.message : String(e),
    });
    return errorRedirect(req, 'token_exchange_failed');
  }

  // returnTo は authorize で相対パス検証済だが、redirect を実行する**この地点でも再検証**する
  // (永続化した値を信頼しない・同一オリジン相対パスのみ許可で open-redirect を多層防御。
  //  '//evil' や 'https://evil' は弾いて '/' に倒す)。
  const ret = stateValue.returnTo;
  const safeReturn =
    typeof ret === 'string' && ret.startsWith('/') && !ret.startsWith('//') ? ret : '/';
  const dest = new URL(safeReturn, req.url);
  dest.searchParams.set('freee', 'connected');
  return NextResponse.redirect(dest);
}
