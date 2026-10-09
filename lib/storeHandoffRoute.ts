import 'server-only';

// 受け渡し API の route 共通処理 (flag・本文サイズ・JSON・応答の形)。

import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { MAX_BODY_BYTES } from '@/lib/relay/relayRoute';
import type { HandoffFailure } from '@/lib/storeHandoff';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function handoffDisabled(): NextResponse | null {
  return env.enableStoreGasWallet
    ? null
    : NextResponse.json({ ok: false, error: 'not_found' }, { status: 404, headers: NO_STORE });
}

export function handoffJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function handoffFailure(f: HandoffFailure): NextResponse {
  return handoffJson({ ok: false, error: f.error }, f.status);
}

// 本文は読みながら上限 (4 KB) を数え、超えた時点で読むのをやめる (全部読んでから測ると、上限がメモリ確保を止めない)。
export async function readHandoffBody(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: NextResponse }> {
  const read = await readJsonBodyCapped(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? { ok: false, res: handoffJson({ ok: false, error: 'payload_too_large' }, 413) }
      : { ok: false, res: handoffJson({ ok: false, error: 'invalid_json' }, 400) };
  }
  const raw = read.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, res: handoffJson({ ok: false, error: 'invalid_body' }, 400) };
  }
  return { ok: true, body: raw as Record<string, unknown> };
}
