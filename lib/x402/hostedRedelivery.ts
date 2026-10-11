import 'server-only';

// hosted 購入 (JPYC・USDC) で、確定した後に署名ヘッダーを再送されたときに本文を返す窓。
//
// 署名ヘッダーの再送は、応答を取りこぼした買い手の再試行のためにある (plans/creator-store-v3.md §6)。
// 再送で一致を求める値 (payer・resourceId・署名内容・署名の指紋) は、どれもオンチェーンの calldata
// (forwarder の settle / USDC の transferWithAuthorization) から組み立てられる。窓を区切らないと、
// 確定した購入物を、ヘッダーを持たない他人でも無期限に取れてしまう。
// 恒久的な再取得は SIWE の library / content API (/api/store/content) が担う (同 §7)。
//
// 窓の起点は、署名された authorization の validBefore (保存済みの claim・秒)。
// 確定を記録した時刻 (settledAt) は起点にしない。決済待ちの購入は、誰でも呼べる照合 (status API や
// paid route の再送) で確定し、settledAt はその照合の時刻になる。settledAt を起点にすると、
// calldata から組み立てたヘッダーを持つ他人が、照合させる時点を選んで窓を開けられる。
// validBefore は買い手の署名に含まれ、再送は保存済みの claim との完全一致が条件なので、他人は動かせない。
// settle は validBefore より前にしか成立しないので、正規の買い手には確定から 20 分以上の窓が残る。
// validBefore は見積もりから最大 10 分なので、窓の終わりは見積もりから最大 30 分になる
// (自社商品・agent 注文の再配信 record の TTL・PAYMENT_REDELIVERY_TTL_SEC と同じ長さ)。

import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import { logger } from '@/lib/logger';

export const HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS = 20 * 60 * 1_000;

export const HOSTED_REDELIVERY_EXPIRED_ERROR = 'purchase_redelivery_expired';

const WINDOW_MINUTES = HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS / 60_000;
const LIBRARY_PATH = '/store/library';

function validBeforeMs(validBefore: string): number {
  return Number(validBefore) * 1_000;
}

/**
 * 署名の validBefore から 20 分の内側なら true。settledAt は受け取らない (起点にしない理由は上)。
 * validBefore は両 rail の parser が正準の 10 進数を必須にしていて、欠けた記録は読み取りの時点で弾かれる。
 * 数値にならない値は NaN になり、比較が false (= 本文を返さない) になる。
 */
export function hostedRedeliveryOpen(
  claim: { validBefore: string },
  now: number = Date.now(),
): boolean {
  return now < validBeforeMs(claim.validBefore) + HOSTED_REDELIVERY_AFTER_VALID_BEFORE_MS;
}

/**
 * 窓を過ぎた再送への 409。本文 (value) は含めず、購入の証拠 (txHash・network) と、
 * 恒久的な取り直し先 (library・content API) を返す。
 */
export function hostedRedeliveryExpiredResponse(input: {
  rail: 'jpyc' | 'usdc';
  resourceId: string;
  chainId: number;
  txHash: Hex;
  settledAt: number;
  validBefore: string;
  now?: number;
}): NextResponse {
  const now = input.now ?? Date.now();
  try {
    logger.warn('x402.hosted.redelivery_expired', {
      rail: input.rail,
      resourceId: input.resourceId,
      // 確定の記録からの経過が短く、validBefore からの経過が長いものは、決済待ちを後から照合した購入。
      ageSec: Math.floor((now - input.settledAt) / 1_000),
      sinceValidBeforeSec: Math.floor((now - validBeforeMs(input.validBefore)) / 1_000),
    });
  } catch {
    // 観測用の warn (console・Sentry) の障害を、本文を返さない 409 応答へ波及させない (掟 13)。
  }
  return NextResponse.json(
    {
      ok: false,
      error: HOSTED_REDELIVERY_EXPIRED_ERROR,
      state: 'settled',
      resourceId: input.resourceId,
      txHash: input.txHash,
      network: `eip155:${input.chainId}`,
      library: LIBRARY_PATH,
      contentApi: `/api/store/content/${encodeURIComponent(input.resourceId)}`,
      message: `This purchase is already settled. Resending the payment header returns the content only until ${WINDOW_MINUTES} minutes after the signed payment authorization expires (validBefore). Do not pay again: sign in with the paying wallet (SIWE) and open it from your library (${LIBRARY_PATH}).`,
      messageJa: `この購入は確定済みです。支払いの署名ヘッダーを再送して中身を受け取れるのは、署名した支払いの有効期限（validBefore）から ${WINDOW_MINUTES} 分後までだけです。もう一度支払わずに、支払ったウォレットでサインインして、ライブラリ（${LIBRARY_PATH}）から開いてください。`,
    },
    { status: 409 },
  );
}
