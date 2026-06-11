// 「freee に同期」batch push の核。SIWE 必須 + freee 連携/マッピング済が前提 (利用権ゲートなし=無料)。
// クライアントが income-sale entries を送る → サーバで再検証 + 円換算 + 冪等 createDeal。
// 冪等性 (SET NX claim) により再クリックしても取引を重複作成しない。
import { NextResponse } from 'next/server';
import type { HistoryEntry } from '@/lib/history';
import { freeeEnv, getValidAccessToken, createDeal } from '@/lib/freee';
import { runFreeeSync } from '@/lib/freeeSync';
import { logger } from '@/lib/logger';
import { env as appEnv } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import {
  getToken,
  setToken,
  delToken,
  getMapping,
  claimSync,
  finalizeSync,
  releaseSync,
} from '../_store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// runFreeeSync は createDeal を**逐次**実行する (冪等順序 + freee への過負荷回避)。
// 実運用の想定負荷は「期間フィルタ後の数〜数十件」で数秒で完了する。MAX_SYNC_ENTRIES は
// 悪用/事故の上限ガードで、満タンの逐次処理は serverless timeout を超え得るため、UI 側は
// 期間 (月) で絞って同期する運用を推奨。関数上限を 60s に引き上げておく (Vercel)。
export const maxDuration = 60;

// 1 回の同期で受け付ける最大件数 (HISTORY_MAX_ENTRIES に整合・DoS 上限)。
const MAX_SYNC_ENTRIES = 1000;

export async function POST(req: Request): Promise<NextResponse> {
  // kill-switch: フラグ OFF の間は UI 非表示に加え API 自体も閉じる (直接 POST を防ぐ)
  if (!appEnv.enableFreeeSync) {
    return NextResponse.json({ ok: false, error: 'freee_disabled' }, { status: 503 });
  }
  const session = await requireSession();
  if (!session.ok) return session.response;

  // freee 同期は無料機能 (SIWE ログインのみ)。有料化は freee 有料アプリ要件を満たしてから別途。
  const env = freeeEnv();
  if (!env) {
    return NextResponse.json({ ok: false, error: 'freee_not_configured' }, { status: 503 });
  }
  const token = await getToken(session.address);
  if (!token) {
    return NextResponse.json({ ok: false, error: 'not_connected' }, { status: 409 });
  }
  const mapping = await getMapping(session.address);
  // mapping は会社(事業所)固有の勘定科目/税区分 ID。別会社に再連携すると旧 ID を指す stale
  // mapping が残るため、現在の連携会社と一致しなければ再マッピングを要求する (誤会社計上防止)。
  if (!mapping || mapping.companyId !== token.companyId) {
    return NextResponse.json({ ok: false, error: 'mapping_required' }, { status: 409 });
  }

  let body: { entries?: unknown; usdcJpy?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const entries = Array.isArray(body.entries) ? (body.entries as HistoryEntry[]) : [];
  if (entries.length === 0) {
    return NextResponse.json({ ok: false, error: 'no_entries' }, { status: 400 });
  }
  if (entries.length > MAX_SYNC_ENTRIES) {
    return NextResponse.json(
      { ok: false, error: 'too_many_entries', max: MAX_SYNC_ENTRIES },
      { status: 400 },
    );
  }

  let access: string;
  try {
    access = await getValidAccessToken(env, token, (next) =>
      setToken(session.address, next),
    );
  } catch (e) {
    // refresh 失敗 (freee 障害 / refresh 失効) は生 500 でなく 502 + Sentry。
    const reason = e instanceof Error ? e.message : String(e);
    logger.error('freee.sync.token_refresh_failed', { reason });
    // 4xx = refresh token 失効/取消 → token を破棄して再連携を促す (502 ループ stuck 回避)。
    // 5xx/network は transient なので token は残す。
    if (/freee_token_http_4\d\d/.test(reason)) await delToken(session.address);
    return NextResponse.json({ ok: false, error: 'token_refresh_failed' }, { status: 502 });
  }

  const summary = await runFreeeSync(entries, {
    wallet: session.address,
    usdcJpy: typeof body.usdcJpy === 'number' ? body.usdcJpy : undefined,
    mapping,
    claim: claimSync,
    createDeal: (deal) => createDeal(access, deal),
    finalize: finalizeSync,
    release: releaseSync,
  });

  // 一部でも createDeal が失敗していれば freee API の不調として観測 (alert 対象)。
  if (summary.errored > 0) {
    logger.warn('freee.sync.partial_failure', {
      synced: summary.synced,
      skipped: summary.skipped,
      errored: summary.errored,
      errors: summary.items
        .filter((i) => i.status === 'error')
        .map((i) => i.error)
        .slice(0, 3),
    });
  }

  return NextResponse.json({ ok: true, ...summary });
}
