// 蓄積した payment log の export endpoint。
// Authorization: Bearer <PAYMENT_LOG_ADMIN_TOKEN> を要求。
// 既定で全件 (LRANGE 0 -1) を JSON 配列で返す。?from / ?to で範囲指定可能。
// 6 ヶ月運用後の弁護士 review / GMV 集計用。

import { NextResponse } from 'next/server';
import { kvLrange, kvLlen, isKvConfigured } from '@/lib/kv';

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
  const auth = req.headers.get('authorization') ?? '';
  // timing-safe ではないが、admin endpoint かつ token 形状の secret 想定で許容
  if (auth !== `Bearer ${adminToken}`) {
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

  const range = await kvLrange(KV_KEY, from, to);
  if (!range.ok) {
    return NextResponse.json(
      { ok: false, error: 'kv_read_failed', reason: range.reason },
      { status: 502 },
    );
  }
  const len = await kvLlen(KV_KEY);
  const total = len.ok ? len.value : null;

  const entries = range.value.map((s) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return { _parseError: true, raw: s };
    }
  });

  return NextResponse.json({ ok: true, total, returned: entries.length, entries });
}
