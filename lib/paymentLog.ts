// alpha 取引 log: client → /api/log/payment → Vercel KV。
// 弁護士 review / 金融庁事前相談 / GMV 集計用。fire-and-forget で UI を阻害しない。

import type { Address, Hex } from 'viem';
import { logger } from './logger';

export type PaymentResult = 'success' | 'reverted' | 'error';
// batch:             gasless 経路 (UserOp で merchant + fee を 1 batch 送信)
// direct:            同一チェーン直接送金。cross-chain mint 成功ログで現役生成
//                    される + 旧 mode=direct の過去 log も含む。
// standard-merchant: 通常決済（ガスあり）の merchant への送金 tx (EOA writeContract)
// standard-fee:      通常決済（ガスあり）の OpenPay 利用手数料徴収 tx (EOA writeContract)
export type PaymentFlow =
  | 'batch'
  | 'direct'
  | 'standard-merchant'
  | 'standard-fee';

// cross-chain bridge 経由で着金した場合の経路識別子。direct (= 既存単一 chain
// transfer) は undefined。Gateway / CCTP V2 を実行した場合のみ string が入る。
// stats endpoint で bridge 別 GMV 集計に使う ([[cross-chain-usdc-receive]] phase 3)。
export type PaymentBridge = 'gateway' | 'cctp-v2';

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
  // cross-chain で利用料を merchant 送金とは別 tx で着金させた場合の fee mint tx hash。
  // 同一 chain の batch/standard では fee は txHash と同 tx 内なので undefined。
  feeTxHash?: Hex;
  blockNumber?: string;
  errorMessage?: string;
  // optional: cross-chain bridge 経由なら 'gateway' or 'cctp-v2'。
  // direct (同一 chain) なら undefined (省略)。
  bridge?: PaymentBridge;
  // bridge 経由時の source chain ID (本 chainId は destination)。
  // direct の場合は undefined。
  sourceChainId?: number;
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
  // cross-chain で利用料を別 tx で着金させた場合の fee mint tx hash (監査用)。
  feeTxHash?: Hex;
  // cross-chain bridge 経由の場合のみ指定。direct (= 既存単一 chain) では undefined。
  bridge?: PaymentBridge;
  sourceChainId?: number;
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
    feeTxHash: ctx.feeTxHash,
    bridge: ctx.bridge,
    sourceChainId: ctx.sourceChainId,
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

// 二段構えで audit dropout を観測:
//   (1) DevTools 用 CustomEvent — production console を汚さず開発者が観測
//   (2) logger.warn (Sentry 経由) — production で aggregate 監視可能にする
// 監視目的の機能で fetch 失敗を完全 silent にしないため、両経路を残す。
export const PAYMENT_LOG_FAILURE_EVENT = 'openpay:payment-log-failure';

function emitFailure(event: PaymentLogEvent, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.warn('payment-log.client-post-failed', {
    flow: event.flow,
    result: event.result,
    chainId: event.chainId,
    txHash: event.txHash,
    error: errorMessage,
  });
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(PAYMENT_LOG_FAILURE_EVENT, {
      detail: {
        ts: new Date().toISOString(),
        event,
        error: errorMessage,
      },
    }),
  );
}

export async function logPaymentEvent(event: PaymentLogEvent): Promise<void> {
  try {
    const res = await fetch('/api/log/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      // tab close / navigation 直後でも POST 完了させる
      keepalive: true,
    });
    if (!res.ok) {
      emitFailure(event, new Error(`http_${res.status}`));
    }
  } catch (e) {
    // network / CSP / test env では throw する。silent に消すと audit が
    // 欠落するため、CustomEvent で observability を残す (production console
    // を noise しない設計)。
    emitFailure(event, e);
  }
}
