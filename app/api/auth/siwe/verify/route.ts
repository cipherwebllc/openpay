// SIWE message + signature を検証してセッション cookie を確立する。
// 検証ロジックは lib/siwe.ts の純粋コア (verifySiweLogin) に集約し、ここは
// KV / viem / cookie の実依存を注入する薄いアダプタ。
//
// 署名検証は viem verifySiweMessage に委譲 (EOA はローカル ECDSA recover、スマート
// アカウントは ERC-6492/1271 を message の chainId 上の public client で検証)。
import { NextResponse } from 'next/server';
import { createPublicClient } from 'viem';
import { verifySiweMessage } from 'viem/siwe';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { isKvConfigured, kvDel, kvSet } from '@/lib/kv';
import { chainObjectForId, isSupportedChainId, transportForChain } from '@/lib/chains';
import { logger } from '@/lib/logger';
import { clientIp, hashIp } from '@/lib/net/ipHash';
import { checkIpRateLimit } from '@/lib/relay/relayGuards';
import {
  sessionCookieName,
  SESSION_TTL_SEC,
  isAllowedSiweDomain,
  newSessionToken,
  nonceKey,
  sessionKey,
  verifySiweLogin,
} from '@/lib/siwe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIWE_VERIFY_BODY_MAX_BYTES = 8 * 1024;

export async function POST(req: Request): Promise<NextResponse> {
  if (!isKvConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'kv_not_configured' },
      { status: 503 },
    );
  }
  if (!(await checkIpRateLimit('siwe-verify', hashIp(clientIp(req)), 30, 60))) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const cappedBody = await readJsonBodyCapped(req, SIWE_VERIFY_BODY_MAX_BYTES);
  if (!cappedBody.ok) {
    if (cappedBody.reason === 'too_large') {
      return NextResponse.json(
        { ok: false, error: 'payload_too_large' },
        { status: 413 },
      );
    }
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const body = cappedBody.value as { message?: unknown; signature?: unknown };

  // domain 束縛はサーバ制御の許可リストで判定する (Host ヘッダは偽装可能なので使わない —
  // phishing replay 防止のため comparand をリクエスト由来にしない)。
  // createSession の永続化失敗など想定外 throw は 503 に倒し、cookie を発行しない
  // (= セッション無効なのに login 成功に見える false-success を防ぐ)。
  let result: Awaited<ReturnType<typeof verifySiweLogin>>;
  try {
    result = await verifySiweLogin(
      { message: body.message, signature: body.signature },
      {
      isSupportedChainId,
      isAllowedDomain: isAllowedSiweDomain,
      verify: async ({ message, signature, address, domain, nonce, chainId }) => {
        const chain = chainObjectForId(chainId);
        if (!chain) return false;
        const client = createPublicClient({
          chain,
          transport: transportForChain(chainId),
        });
        return verifySiweMessage(client, {
          message,
          signature,
          address,
          domain,
          nonce,
        });
      },
      // DEL は atomic: 同時送信でも count===1 を得るのは 1 つだけ → replay 安全。
      consumeNonce: async (nonce) => {
        const del = await kvDel(nonceKey(nonce));
        return del.ok && del.value === 1;
      },
      createSession: async (address) => {
        const token = newSessionToken();
        const set = await kvSet(sessionKey(token), JSON.stringify({ address }), {
          ttlSec: SESSION_TTL_SEC,
        });
        // 保存失敗 = cookie を出してもセッション無効。throw して 503 に倒し cookie を出さない。
        if (!set.ok) {
          logger.error('siwe.session.persist_failed', { reason: set.reason });
          throw new Error('session_persist_failed');
        }
        return token;
      },
    },
    );
  } catch (e) {
    logger.error('siwe.verify.unexpected', {
      reason: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ ok: false, error: 'verify_failed' }, { status: 503 });
  }

  if (!result.ok) {
    // domain_mismatch は phishing replay の兆候になり得るのでセキュリティイベントとして上げる
    // (通常の署名ミス/nonce 失効はユーザ起因なので記録しない=ノイズ回避)。
    if (result.error === 'domain_mismatch') {
      logger.warn('siwe.verify.domain_mismatch');
    }
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }

  const res = NextResponse.json({ ok: true, address: result.address });
  // 本番の cookie 名は `__Host-` prefix 付き (lib/siwe sessionCookieName)。ブラウザの受理条件
  // = Secure + Path=/ + Domain 属性なし。この 3 つを満たす属性でのみ発行する。
  res.cookies.set(sessionCookieName(), result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
  return res;
}
