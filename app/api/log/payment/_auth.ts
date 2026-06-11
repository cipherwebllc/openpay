// admin endpoint (payment log の export / stats) 共通の Bearer 認証 + KV 設定ガード。
// 両 route で byte-identical だった 3 分岐を 1 箇所に集約し、auth が drift するのを防ぐ。
// auth は untrusted 入力境界なので status code / error 文字列は厳密に保持すること
// (`_` prefix のため Next.js の route 探索対象外)。
import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isKvConfigured } from '@/lib/kv';

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/** 認証 / 設定が NG なら error の NextResponse を、OK なら null を返す。
 * caller は `const err = requireAdminAuth(req); if (err) return err;` で使う。 */
export function requireAdminAuth(req: Request): NextResponse | null {
  const adminToken = process.env.PAYMENT_LOG_ADMIN_TOKEN;
  if (!adminToken) {
    return NextResponse.json(
      { ok: false, error: 'admin_token_not_configured' },
      { status: 503 },
    );
  }
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !safeEqual(authHeader, `Bearer ${adminToken}`)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    );
  }
  if (!isKvConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'kv_not_configured' },
      { status: 503 },
    );
  }
  return null;
}
