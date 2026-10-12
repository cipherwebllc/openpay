import 'server-only';

// hosted 購入 (JPYC・USDC) で、確定済みの購入へ署名ヘッダーを再送されたときの 409。
//
// 再送で一致を求める値 (payer・resourceId・署名内容・署名の指紋) は、どれもオンチェーンの calldata
// (forwarder の settle / USDC の transferWithAuthorization) から組み立てられる。server は買い手の再試行と、
// calldata を見た他人を区別できないので、確定済みの購入への再送では本文 (value) を返さない (窓 0)。
// 本文を返すのは、その request 自身が settle を呼んで成功した初回の応答だけ。
// 確定後の取り直しは SIWE の library / content API (/api/store/content) が担う (plans/creator-store-v3.md §7)。
// ブラウザ (hooks/useHostedStorePurchase) はこの 409 を、error code の名前ではなく形
// (409・state settled・txHash・resourceId) で確定として扱い、本文を content API から読む。

import { NextResponse } from 'next/server';
import type { Hex } from 'viem';
import { logger } from '@/lib/logger';

export const HOSTED_ALREADY_SETTLED_ERROR = 'purchase_already_settled';

const LIBRARY_PATH = '/store/library';

/**
 * 確定済みの購入への再送に返す 409。本文 (value) と PAYMENT-RESPONSE は含めず、購入の証拠
 * (txHash・network) と、取り直し先 (library・content API) を返す。
 */
export function hostedAlreadySettledResponse(input: {
  rail: 'jpyc' | 'usdc';
  resourceId: string;
  chainId: number;
  txHash: Hex;
  settledAt: number;
  now?: number;
}): NextResponse {
  // 正規の再試行 (応答の取りこぼし・決済待ちの後の再試行) もここを通るので、Sentry へ送る warn にはしない。
  logger.info('x402.hosted.redelivery_refused', {
    rail: input.rail,
    resourceId: input.resourceId,
    ageSec: Math.floor(((input.now ?? Date.now()) - input.settledAt) / 1_000),
  });
  return NextResponse.json(
    {
      ok: false,
      error: HOSTED_ALREADY_SETTLED_ERROR,
      state: 'settled',
      resourceId: input.resourceId,
      txHash: input.txHash,
      network: `eip155:${input.chainId}`,
      library: LIBRARY_PATH,
      contentApi: `/api/store/content/${encodeURIComponent(input.resourceId)}`,
      message: `This purchase is already settled. Do not pay again: sign in with the paying wallet (SIWE) and open it from your library (${LIBRARY_PATH}).`,
      messageJa: `この購入は確定済みです。もう一度支払わずに、支払ったウォレットでサインインしてライブラリ（${LIBRARY_PATH}）から開いてください。`,
    },
    { status: 409 },
  );
}
