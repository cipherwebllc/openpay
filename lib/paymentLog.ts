// alpha 取引 log: client → /api/log/payment → Vercel KV。
// 弁護士 review / 金融庁事前相談 / GMV 集計用。fire-and-forget で UI を阻害しない。

import type { Address, Hex } from 'viem';

export type PaymentResult = 'success' | 'reverted' | 'error';
export type PaymentFlow = 'batch' | 'direct';

export type PaymentLogEvent = {
  flow: PaymentFlow;
  result: PaymentResult;
  chainId: number;
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: string;
  customer?: Address;
  feeReceiver?: Address;
  feeAmount?: string;
  userOpHash?: Hex;
  txHash?: Hex;
  blockNumber?: string;
  errorMessage?: string;
};

// 全 hook が共通で持つ「flow / chain / merchant / customer」を 1 度に詰める。
// hook 側は flow 固有 (userOpHash / errorMessage 等) のみ追加すればよい。
export type PaymentLogContext = {
  flow: PaymentFlow;
  chainId: number;
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: bigint;
  customer?: Address;
  feeReceiver?: Address;
  feeAmount?: bigint;
};

export function buildPaymentLogEvent(
  ctx: PaymentLogContext,
  outcome:
    | {
        result: 'success' | 'reverted';
        userOpHash?: Hex;
        txHash?: Hex;
        blockNumber?: bigint;
      }
    | { result: 'error'; errorMessage: string; txHash?: Hex },
): PaymentLogEvent {
  const base: PaymentLogEvent = {
    flow: ctx.flow,
    result: outcome.result,
    chainId: ctx.chainId,
    tokenAddress: ctx.tokenAddress,
    merchant: ctx.merchant,
    merchantAmount: ctx.merchantAmount.toString(),
    customer: ctx.customer,
    feeReceiver: ctx.feeReceiver,
    feeAmount: ctx.feeAmount?.toString(),
  };
  if (outcome.result === 'error') {
    return { ...base, errorMessage: outcome.errorMessage.slice(0, 500), txHash: outcome.txHash };
  }
  return {
    ...base,
    userOpHash: outcome.userOpHash,
    txHash: outcome.txHash,
    blockNumber: outcome.blockNumber?.toString(),
  };
}

export async function logPaymentEvent(event: PaymentLogEvent): Promise<void> {
  try {
    await fetch('/api/log/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      // tab close / navigation 直後でも POST 完了させる
      keepalive: true,
    });
  } catch {
    // network / CSP / test env で silently 失敗してよい (server log 側にも残る)
  }
}
