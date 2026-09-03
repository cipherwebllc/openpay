// 受注閲覧トークンの発行/再表示/取消 (オーナー専用・SIWE 必須)。
// 受取ウォレットでサインインした本人だけが、自分の受取アドレス宛トークンを操作できる。
// トークンは **受注の閲覧 + 進捗操作のみ** を店員端末に許す bearer 資格情報 (送金・受取先変更は不可)。
// 失効はトークン削除/再発行で行う。セキュリティの要は feed 側の「現行トークン一致」検証で、ここでの
// 旧 rev 削除は hygiene (失敗しても旧トークンは feed の一致検証で弾かれる)。
// 同時実行: rotate と revoke を **同時** に投げると、各操作は複数の KV コマンド (rotate=rev/pointer 書込,
//   revoke=pointer/rev 削除) ゆえコマンド単位で交錯しうる → revoke が 200 を返しても、割り込んだ rotate の
//   新トークンが pointer に残り有効なままになりうる (厳密な last-writer-wins ではない)。ただし両操作とも
//   オーナーの SIWE 必須の **単一所有者 self-race** で、再 revoke で必ず確定でき、第三者は誘発できないため
//   許容する (この自己競合のために分散ロックは導入しない)。通常運用では rotate/revoke は択一。
// flag NEXT_PUBLIC_ENABLE_ORDER_TOKEN 既定 OFF → 404 (完全 inert)。設計: plans/restaurant-pos-roadmap.md Phase 5。
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { requireSession } from '../../auth/siwe/_session';
import { kvGet, kvSet, kvDel, isKvConfigured } from '@/lib/kv';
import { orderTokenKey, orderTokenRevKey, ORDER_TOKEN_BYTES } from '@/lib/orderToken';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notFound() {
  return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
}
function kvUnavailable() {
  return NextResponse.json({ ok: false, error: 'kv_unavailable' }, { status: 503 });
}
function kvError() {
  return NextResponse.json({ ok: false, error: 'kv_error' }, { status: 503 });
}

/** 現行トークンの再表示 (オーナーがリンクをいつでもコピーできるように)。未発行は token:null。 */
export async function GET(): Promise<NextResponse> {
  if (!env.enableOrderToken) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  if (!isKvConfigured()) return kvUnavailable();

  const res = await kvGet(orderTokenKey(session.address));
  if (!res.ok) {
    logger.warn('order.token.kv_error', { reason: res.reason, op: 'get' });
    return kvError();
  }
  // 受注トークン = 秘密。セッション固有かつ機密なので共有キャッシュに載せない。
  return NextResponse.json(
    { ok: true, token: res.value },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/** 発行 / 再発行 (rotate)。旧トークンは現行一致検証で即失効する。新トークンを 1 度だけ返す。 */
export async function POST(): Promise<NextResponse> {
  if (!env.enableOrderToken) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  if (!isKvConfigured()) return kvUnavailable();

  const merchant = session.address;
  const oldRes = await kvGet(orderTokenKey(merchant));
  if (!oldRes.ok) {
    logger.warn('order.token.kv_error', { reason: oldRes.reason, op: 'rotate_read' });
    return kvError();
  }

  const token = randomBytes(ORDER_TOKEN_BYTES).toString('base64url');
  // lookup 用 (トークン→受取アドレス) を **先に**、pointer/再表示用 (受取アドレス→現行トークン) を後に書く。
  // pointer が「現行トークン」の権威なので最後に確定させる: 片方だけ成功して 503 になっても、pointer 未更新
  // なら旧 pointer/rev が健在 → 旧トークンが生き続ける (新 rev は孤児だが現行一致検証で弾かれ無害) =
  // 部分失敗が fail-safe (オーナーがロックアウトされない)。逆順だと pointer だけ進んで両トークン失効しうる。
  const setRev = await kvSet(orderTokenRevKey(token), merchant);
  if (!setRev.ok) {
    logger.warn('order.token.kv_error', { reason: setRev.reason, op: 'rotate_setrev' });
    return kvError();
  }
  const setKey = await kvSet(orderTokenKey(merchant), token);
  if (!setKey.ok) {
    logger.warn('order.token.kv_error', { reason: setKey.reason, op: 'rotate_setkey' });
    return kvError();
  }
  // 旧 rev の掃除 (best-effort)。失敗しても旧トークンは feed の現行一致検証で弾かれるので安全。
  if (oldRes.value && oldRes.value !== token) {
    await kvDel(orderTokenRevKey(oldRes.value));
  }
  logger.info('order.token.rotated', { merchant });
  return NextResponse.json({ ok: true, token });
}

/** 取消 (revoke)。受取アドレスの現行トークンを消す → 以後どのトークンも feed で弾かれる。 */
export async function DELETE(): Promise<NextResponse> {
  if (!env.enableOrderToken) return notFound();
  const session = await requireSession();
  if (!session.ok) return session.response;
  if (!isKvConfigured()) return kvUnavailable();

  const merchant = session.address;
  const oldRes = await kvGet(orderTokenKey(merchant));
  if (!oldRes.ok) {
    logger.warn('order.token.kv_error', { reason: oldRes.reason, op: 'revoke_read' });
    return kvError();
  }
  // pointer 削除 = 失効 (feed の現行一致検証が必ず false になる)。ここは確実に消えないと失効が成立しない。
  const del = await kvDel(orderTokenKey(merchant));
  if (!del.ok) {
    logger.warn('order.token.kv_error', { reason: del.reason, op: 'revoke_delkey' });
    return kvError();
  }
  if (oldRes.value) await kvDel(orderTokenRevKey(oldRes.value)); // best-effort 掃除
  logger.info('order.token.revoked', { merchant });
  return NextResponse.json({ ok: true });
}
