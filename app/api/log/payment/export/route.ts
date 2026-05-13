// 蓄積した payment log の admin export。Bearer 認証必須。
// 弁護士 review / 金融庁事前相談 / GMV 集計用。

import { NextResponse } from 'next/server';
import { kvLrange, kvLlen, isKvConfigured } from '@/lib/kv';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const KV_KEY = 'openpay:payments:log';

export async function GET(req: Request): Promise<NextResponse> {
  const adminToken = process.env.PAYMENT_LOG_ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json(
      { ok: false, error: 'admin_token_not_configured' },
      { status: 503 },
    );
  }
  if (req.headers.get('authorization') !== `Bearer ${adminToken}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  if (!isKvConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'kv_not_configured' },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const from = Number(url.searchParams.get('from') ?? 0);
  const to = Number(url.searchParams.get('to') ?? -1);

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

  return NextResponse.json({
    ok: true,
    total: len.ok ? len.value : null,
    returned: entries.length,
    entries,
  });
}
