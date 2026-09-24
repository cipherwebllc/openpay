// 勘定科目/税区分の ID マッピング (freee deals は名前でなく ID 指定が必須)。
//   GET  : 選択肢 (account_items / tax codes) + 現在のマッピングを返す。
//   POST : 店主が選んだ accountItemId / taxCode を保存。
// いずれも SIWE 必須 + freee 連携済が前提。
import { NextResponse } from 'next/server';
import {
  freeeEnv,
  getAccountItems,
  getTaxCodes,
} from '@/lib/freee';
import { logger } from '@/lib/logger';
import { env as appEnv } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { getToken, getWalletAccessToken, getMapping, setMapping } from '../_store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // kill-switch: フラグ OFF の間は UI 非表示に加え API 自体も閉じる (直接 POST を防ぐ)
  if (!appEnv.enableFreeeSync) {
    return NextResponse.json({ ok: false, error: 'freee_disabled' }, { status: 503 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;
  const env = freeeEnv();
  if (!env) {
    return NextResponse.json({ ok: false, error: 'freee_not_configured' }, { status: 503 });
  }
  const token = await getToken(session.address);
  if (!token || token.companyId == null) {
    return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 });
  }

  try {
    const access = await getWalletAccessToken(env, session.address, token);
    const [accountItems, taxCodes, mapping] = await Promise.all([
      getAccountItems(access, token.companyId),
      getTaxCodes(access),
      getMapping(session.address),
    ]);
    return NextResponse.json({ ok: true, accountItems, taxCodes, mapping });
  } catch (e) {
    // freee API 不調 / token refresh 失敗は生 500 でなく 502 + Sentry。
    const reason = e instanceof Error ? e.message : String(e);
    logger.warn('freee.mapping.fetch_failed', { reason });
    return NextResponse.json({ ok: false, error: 'mapping_fetch_failed' }, { status: 502 });
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!appEnv.enableFreeeSync) {
    return NextResponse.json({ ok: false, error: 'freee_disabled' }, { status: 503 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;
  const token = await getToken(session.address);
  if (!token || token.companyId == null) {
    return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 });
  }

  let body: { accountItemId?: unknown; taxCode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  // JSON の `null` / 数値 / 文字列も parse は成功する。object でなければ欄を読む前に 400 で返す
  // (null のまま欄を読むと TypeError → 500 + Sentry event になっていた・第 6 回 B-R6f)。
  if (body === null || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (
    typeof body.accountItemId !== 'number' ||
    typeof body.taxCode !== 'number'
  ) {
    return NextResponse.json({ ok: false, error: 'invalid_mapping' }, { status: 400 });
  }

  const saved = await setMapping(session.address, {
    companyId: token.companyId,
    accountItemId: body.accountItemId,
    taxCode: body.taxCode,
  });
  if (!saved) {
    return NextResponse.json(
      { ok: false, error: 'mapping_save_failed' },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
