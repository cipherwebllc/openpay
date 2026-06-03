// SIWE セッションの読み取り共通ヘルパ (`_auth.ts` に倣い `_` prefix で route 探索対象外)。
// cookie (op_sess) → KV セッションレコード → checksum アドレスを引く。protected route
// (freee / entitlement) はすべて requireSession を最初に呼ぶ。
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { Address } from 'viem';
import { kvGet } from '@/lib/kv';
import { SESSION_COOKIE, sessionKey, parseSessionRecord } from '@/lib/siwe';

/** cookie のセッショントークン → checksum アドレス。未ログイン/失効は null。 */
export async function getSessionAddress(): Promise<Address | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await kvGet(sessionKey(token));
  if (!res.ok) return null;
  return parseSessionRecord(res.value)?.address ?? null;
}

export type RequireSessionResult =
  | { ok: true; address: Address }
  | { ok: false; response: NextResponse };

/** 未ログインなら 401 の NextResponse を返す。caller は
 *  `const s = await requireSession(); if (!s.ok) return s.response;` で使う。 */
export async function requireSession(): Promise<RequireSessionResult> {
  const address = await getSessionAddress();
  if (!address) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'unauthenticated' },
        { status: 401 },
      ),
    };
  }
  return { ok: true, address };
}
