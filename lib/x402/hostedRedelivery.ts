import 'server-only';

// hosted 購入 (JPYC・USDC) で、確定した後に署名ヘッダーを再送されたときに本文を返す窓。
//
// 署名ヘッダーの再送は、応答を取りこぼした買い手の再試行のためにある (plans/creator-store-v3.md §6)。
// 再送で一致を求める値 (payer・resourceId・署名内容・署名の指紋) は、どれもオンチェーンの calldata
// (forwarder の settle / USDC の transferWithAuthorization) から組み立てられる。窓を区切らないと、
// 確定した購入物を、ヘッダーを持たない他人でも無期限に取れてしまう。
// 恒久的な再取得は SIWE の library / content API (/api/store/content) が担う (同 §7)。
// 窓の長さは、自社商品と agent 注文の再配信 record の TTL と同じ定数を使う。

import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import { logger } from '@/lib/logger';
import { PAYMENT_REDELIVERY_TTL_SEC } from '@/lib/x402/paymentRedelivery';

export const HOSTED_REDELIVERY_WINDOW_MS = PAYMENT_REDELIVERY_TTL_SEC * 1_000;

export const HOSTED_REDELIVERY_EXPIRED_ERROR = 'purchase_redelivery_expired';

const WINDOW_MINUTES = PAYMENT_REDELIVERY_TTL_SEC / 60;
const LIBRARY_PATH = '/store/library';

/** settledAt (確定を記録した server 時刻) から窓の内側なら true。 */
export function hostedRedeliveryOpen(
  settledAt: number,
  now: number = Date.now(),
): boolean {
  return now - settledAt < HOSTED_REDELIVERY_WINDOW_MS;
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
  now?: number;
}): NextResponse {
  const now = input.now ?? Date.now();
  try {
    logger.warn('x402.hosted.redelivery_expired', {
      rail: input.rail,
      resourceId: input.resourceId,
      ageSec: Math.floor((now - input.settledAt) / 1_000),
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
      message: `This purchase is already settled. Resending the payment header returns the content only within ${WINDOW_MINUTES} minutes of settlement. Do not pay again: sign in with the paying wallet (SIWE) and open it from your library (${LIBRARY_PATH}).`,
      messageJa: `この購入は確定済みです。支払いの署名ヘッダーを再送して中身を受け取れるのは、確定から ${WINDOW_MINUTES} 分以内だけです。もう一度支払わずに、支払ったウォレットでサインインして、ライブラリ（${LIBRARY_PATH}）から開いてください。`,
    },
    { status: 409 },
  );
}
