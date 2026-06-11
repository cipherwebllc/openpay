// 蓄積した payment log の admin export。Bearer 認証必須。
// 弁護士 review / 金融庁事前相談 / GMV 集計用。窓上限 EXPORT_MAX_WINDOW・全量は nextFrom でページング可。

import { NextResponse } from 'next/server';
import { kvLrange, kvLlen } from '@/lib/kv';
import { logger } from '@/lib/logger';
import { requireAdminAuth } from '../_auth';

export const runtime = 'nodejs';

const KV_KEY = 'openpay:payments:log';
const EXPORT_MAX_WINDOW = 10_000;

export async function GET(req: Request): Promise<NextResponse> {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const from = Number(url.searchParams.get('from') ?? 0);
  const toRaw = url.searchParams.get('to');
  const to = toRaw === null ? from + EXPORT_MAX_WINDOW - 1 : Number(toRaw);

  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    to < from ||
    to - from + 1 > EXPORT_MAX_WINDOW
  ) {
    return NextResponse.json(
      { ok: false, error: 'invalid_window', maxWindow: EXPORT_MAX_WINDOW },
      { status: 400 },
    );
  }

  const [range, len] = await Promise.all([
    kvLrange(KV_KEY, from, to),
    kvLlen(KV_KEY),
  ]);

  if (!range.ok) {
    logger.warn('payment-log.export-read-failed', {
      reason: range.reason,
      status: range.status,
    });
    return NextResponse.json(
      { ok: false, error: 'kv_read_failed' },
      { status: 502 },
    );
  }

  const entries = range.value.map((s) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return { _parseError: true, raw: s };
    }
  });

  const total = len.ok ? len.value : null;
  const nextFrom =
    total !== null
      ? to + 1 < total ? to + 1 : null
      : entries.length === to - from + 1 ? to + 1 : null;

  return NextResponse.json({
    ok: true,
    total,
    returned: entries.length,
    nextFrom,
    entries,
  });
}
