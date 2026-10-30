// SIWE セッションの読み取り共通ヘルパ (実体)。
// cookie (sessionCookieName()) → KV セッションレコード → checksum アドレスを引く。protected route
// (freee / entitlement) はすべて requireSession を最初に呼ぶ。
//
// 入口は 2 つで、どちらも eslint.config.mjs の規則が強制する (F-4):
// - app/ は facade の `app/api/auth/siwe/_session.ts` (再エクスポートだけ) から import する。
// - lib/ は app/ を import できないので、このファイル `@/lib/siweSession` を直接 import する。
// tests が vi.mock するのはこのファイル (`@/lib/siweSession`) だけ。facade を mock しても、
// ここを直接 import する lib/* (orderFeedAuth・entitlementStatusRoute・agent/purchasesHttp) には
// 届かず、本物の cookies()/kvGet に当たる。
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { Address } from 'viem';
import { kvGet } from '@/lib/kv';
import { sessionCookieName, sessionKey, parseSessionRecord, isSessionToken } from '@/lib/siwe';

export type SessionReadResult =
  | { status: 'authenticated'; address: Address }
  | { status: 'missing' }
  | { status: 'storage-error' };

/** cookie と KV record を読み、未認証とストレージ障害を区別する。 */
export async function readSession(): Promise<SessionReadResult> {
  const store = await cookies();
  const token = store.get(sessionCookieName())?.value;
  // newSessionToken() issues exactly 64 lowercase hex characters. Reject malformed
  // cookies before KV so anonymous junk cannot drain the budget shared with payments.
  if (!token || !isSessionToken(token)) {
    return { status: 'missing' };
  }
  const res = await kvGet(sessionKey(token));
  if (!res.ok) return { status: 'storage-error' };
  const record = parseSessionRecord(res.value);
  return record
    ? { status: 'authenticated', address: record.address }
    : { status: 'missing' };
}

export type RequireSessionResult =
  | { ok: true; address: Address }
  | { ok: false; response: NextResponse };

/** 未ログインなら 401、KV 読取障害なら 503 の NextResponse を返す。caller は
 *  `const s = await requireSession(); if (!s.ok) return s.response;` で使う。 */
export async function requireSession(): Promise<RequireSessionResult> {
  const session = await readSession();
  if (session.status === 'storage-error') {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'session_storage_unavailable' },
        { status: 503 },
      ),
    };
  }
  if (session.status === 'missing') {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'unauthenticated' },
        { status: 401 },
      ),
    };
  }
  return { ok: true, address: session.address };
}
