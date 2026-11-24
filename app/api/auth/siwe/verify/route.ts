// SIWE message + signature を検証してセッション cookie を確立する。
// 検証ロジックは lib/siwe.ts の純粋コア (verifySiweLogin) に集約し、ここは
// KV / viem / cookie の実依存を注入する薄いアダプタ。
//
// 署名検証は viem verifySiweMessage に委譲 (EOA はローカル ECDSA recover、スマート
// アカウントは ERC-6492/1271 を message の chainId 上の public client で検証)。
import { NextResponse } from 'next/server';
import { rejectCrossOriginWrite } from '@/lib/net/crossOriginWrite';
import { createPublicClient, isAddressEqual, recoverMessageAddress } from 'viem';
import { verifySiweMessage } from 'viem/siwe';
import { readJsonBodyCapped } from '@/lib/httpBodyCap';
import { isKvConfigured, kvDel, kvGet, kvSet } from '@/lib/kv';
import { chainObjectForId, isSupportedChainId, transportForChain } from '@/lib/chains';
import { logger } from '@/lib/logger';
import { checkClientIpBucketRateLimit } from '@/lib/net/clientRateLimit';
import {
  sessionCookieName,
  SESSION_TTL_SEC,
  isAllowedSiweDomain,
  isZeroDataVerificationError,
  newSessionToken,
  nonceKey,
  sessionKey,
  verifySiweLogin,
  type SessionSigner,
} from '@/lib/siwe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIWE_VERIFY_BODY_MAX_BYTES = 8 * 1024;

// 鍵の署名 (65 byte の ECDSA) がそのアドレスに戻れば eoa (どのチェーンでも同じ鍵が持ち主)。スマートウォレットの署名
// (ERC-1271 の持ち主の鍵・6492 / 8010 で包んだ形) は、戻らないか戻せない = contract。7702 で委任した EOA でも、ふつうの
// 鍵の署名なら eoa になる (鍵がどのチェーンでも持ち主のまま)。
async function signerKind(message: string, signature: `0x${string}`, address: `0x${string}`): Promise<SessionSigner> {
  try {
    return isAddressEqual(await recoverMessageAddress({ message, signature }), address) ? 'eoa' : 'contract';
  } catch {
    return 'contract';
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const rejected = rejectCrossOriginWrite(req, { json: true });
  if (rejected) return rejected;
  if (!isKvConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'kv_not_configured' },
      { status: 503 },
    );
  }
  if (!(await checkClientIpBucketRateLimit(req, 'siwe-verify', 30, 60))) {
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
  // JSON の `null` / 数値 / 文字列も parse は成功する。object でなければ欄を読む前に 400 で返す
  // (null のまま欄を読むと TypeError → 500 + Sentry event になっていた・第 6 回 B-R6f)。
  if (cappedBody.value === null || typeof cappedBody.value !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const body = cappedBody.value as { message?: unknown; signature?: unknown };

  // domain 束縛はサーバ制御の許可リストで判定する (Host ヘッダは偽装可能なので使わない —
  // phishing replay 防止のため comparand をリクエスト由来にしない)。
  // createSession の永続化失敗など想定外 throw は 503 に倒し、cookie を発行しない
  // (= セッション無効なのに login 成功に見える false-success を防ぐ)。
  let result: Awaited<ReturnType<typeof verifySiweLogin>>;
  // 署名の種類 (lib/siwe.ts の SessionSigner)。署名が確かめられた後にだけ決め、セッションに残す。既定は contract
  // (eoa と言えるのは、鍵の署名をそのアドレスに戻せたときだけ)。
  let signer: SessionSigner = 'contract';
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
          // CCIP-Read (EIP-3668) は追わない。サポートするのはオンチェーンで完結する署名検証 (EOA / ERC-1271 /
          // 6492 / 8010) で、CCIP-Read に依存する 1271 実装の wallet は対象外とする。
          // 有効のままだと、7702 委任済み EOA + ERC-8010 形の署名で委任先が OffchainLookup を返したとき、
          // viem が revert data に書かれた任意の URL へサーバーから fetch する (正しい署名なしで届く SSRF・
          // 第 9 回レビュー C-1)。false なら revert はただの検証失敗 = 401 invalid_signature になる。
          ccipRead: false,
        });
        try {
          const valid = await verifySiweMessage(client, {
            message,
            signature,
            address,
            domain,
            nonce,
          });
          if (valid) signer = await signerKind(message, signature, address);
          return valid;
        } catch (error) {
          // スマートアカウントの署名 (ERC-8010 等) の検証で chain の呼び出しが空 (0x) を返して読めないときは、送り直しても
          // 同じなので検証失敗 = 401 invalid_signature にする (503 は「あとで送り直して」と伝わり、Sentry の error にも
          // なっていた・2026-11-23)。通信の失敗などはこれまでどおり下の catch で 503。
          if (isZeroDataVerificationError(error)) {
            logger.info('siwe.verify.zero_data', { chainId });
            return false;
          }
          throw error;
        }
      },
      // 存在だけを読む (消費は署名検証の後の DEL)。KV 障害は false = nonce_invalid (consume と同じ扱い)。
      nonceExists: async (nonce) => {
        const got = await kvGet(nonceKey(nonce));
        return got.ok && got.value !== null;
      },
      // DEL は atomic: 同時送信でも count===1 を得るのは 1 つだけ → replay 安全。
      consumeNonce: async (nonce) => {
        const del = await kvDel(nonceKey(nonce));
        return del.ok && del.value === 1;
      },
      createSession: async (address) => {
        const token = newSessionToken();
        const set = await kvSet(sessionKey(token), JSON.stringify({ address, signer }), {
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
    // 署名前に誰でも生成できる拒否を Sentry quota 消費へ波及させない。
    // info は captureMessage しない。domain/署名の検証順序と応答は維持する。
    if (result.error === 'domain_mismatch') {
      logger.info('siwe.verify.domain_mismatch');
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
