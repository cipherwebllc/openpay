// @handle 予約/更新 + 所有一覧 API (SIWE 必須)。NEXT_PUBLIC_ENABLE_HANDLES OFF で 404 (inert)。
//
// POST /api/handle { handle, config, profile? }  → 予約 (新規) or 所有者による設定更新
// GET  /api/handle  → 自分が保有する handle を**レコード込み**で返す (編集 UI の prefill 用)

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '../auth/siwe/_session';
import {
  validateHandle,
  validateHandleTipConfig,
  validateProfile,
  MAX_HANDLES_PER_WALLET,
  type HandleProfile,
} from '@/lib/handle';
import {
  reserveOrUpdateHandle,
  listHandleRecordsForOwner,
} from '@/lib/handleStore';

export const runtime = 'nodejs';
export const maxDuration = 10;

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}

export async function GET() {
  if (!env.enableHandles) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  const owned = await listHandleRecordsForOwner(session.address);
  if (owned === null) {
    return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 502 });
  }
  // 編集 prefill のため config/profile も返す (公開ページと同じレコード)。
  return NextResponse.json({
    ok: true,
    handles: owned.map((o) => ({
      handle: o.handle,
      config: o.record.config,
      profile: o.record.profile,
      updatedAt: o.record.updatedAt,
    })),
    max: MAX_HANDLES_PER_WALLET,
  });
}

export async function POST(req: Request) {
  if (!env.enableHandles) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 400 });
  }
  const {
    handle: rawHandle,
    config: rawConfig,
    profile: rawProfile,
  } = body as Record<string, unknown>;
  if (typeof rawHandle !== 'string') {
    return NextResponse.json({ ok: false, error: 'handle_required' }, { status: 400 });
  }

  const validated = validateHandle(rawHandle);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, error: validated.reason === 'reserved' ? 'reserved' : 'invalid_format' },
      { status: 400 },
    );
  }

  const config = validateHandleTipConfig(rawConfig);
  if (!config.ok) {
    return NextResponse.json(
      { ok: false, error: 'invalid_config', detail: config.error },
      { status: 400 },
    );
  }

  // profile が body に無ければ undefined を渡す (= update で既存 profile を保持)。
  // 明示的に与えられた場合のみ検証して置換 (空 {} はクリア)。
  let profileArg: HandleProfile | undefined;
  if (rawProfile !== undefined && rawProfile !== null) {
    const profile = validateProfile(rawProfile);
    if (!profile.ok) {
      return NextResponse.json(
        { ok: false, error: 'invalid_profile', detail: profile.error },
        { status: 400 },
      );
    }
    profileArg = profile.profile;
  }

  const result = await reserveOrUpdateHandle({
    handle: validated.handle,
    owner: session.address,
    config: config.config,
    profile: profileArg,
    nowMs: Date.now(),
  });

  switch (result.status) {
    case 'created':
      return NextResponse.json(
        { ok: true, handle: validated.handle, status: 'created' },
        { status: 201 },
      );
    case 'updated':
      return NextResponse.json({ ok: true, handle: validated.handle, status: 'updated' });
    case 'taken':
      return NextResponse.json({ ok: false, error: 'taken' }, { status: 409 });
    case 'limit':
      return NextResponse.json(
        { ok: false, error: 'limit', max: MAX_HANDLES_PER_WALLET },
        { status: 409 },
      );
    case 'kv_unavailable':
      return NextResponse.json({ ok: false, error: 'unavailable' }, { status: 503 });
    case 'kv_error':
    default:
      logger.error('handle.reserve.kv_error', { handle: validated.handle });
      return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 502 });
  }
}
