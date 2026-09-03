// alpha 取引 log: client → /api/log/payment → Vercel KV。
// 弁護士 review / 金融庁事前相談 / GMV 集計用。fire-and-forget で UI を阻害しない。

import type { Address, Hex } from 'viem';
import { logger } from './logger';

// KV log の fee/gas 内訳セマンティクスの版。本フィールドを持つ log は分離記録済
// (feeAmount = OpenPay 利用手数料 = サービス料のみ・ガスは networkFeeEquivalent)。
// 持たない旧 log は内訳不明 (feeAmount が conflated) で stats 集計から除外判定する。
// localStorage 側 (lib/history.FEE_BREAKDOWN_VERSION) とは独立の store・独立の版管理。
export const LOG_FEE_BREAKDOWN_VERSION = 1 as const;

// KV 保存先のキー導出 (単一情報源)。
// - PAYMENT_LOG_KV_KEY: 既存の単一リスト。export / stats が読む現役の読み出し口。
//   未認証 write を 1 本の cap 付きリストに集約しているため、量で押されると古い entry が
//   LTRIM で押し出される (eviction)。
// - paymentLogDailyKey: 日次パーティション。1 日分が別キー + TTL なので、ある日の flood が
//   他の日の記録を押し出さない。将来 reader をこちらへ寄せるための土台。
export const PAYMENT_LOG_KV_KEY = 'openpay:payments:log';
const PAYMENT_LOG_DAILY_PREFIX = `${PAYMENT_LOG_KV_KEY}:`;
/** 日次パーティションの保持期間 (会計/法定保存の 7 年ではなく、alpha 運用の 400 日)。 */
export const PAYMENT_LOG_DAILY_TTL_SEC = 400 * 24 * 60 * 60;

/** UTC 日付 (YYYYMMDD) の日次パーティションキー。 */
export function paymentLogDailyKey(now: Date = new Date()): string {
  return `${PAYMENT_LOG_DAILY_PREFIX}${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
}

/**
 * 直近 days 日分の日次パーティションキー (新しい順)。将来の reader (export / stats /
 * 月次メトリクス) が単一の巨大リストではなく日次キーを走査できるようにするための導出。
 */
export function listPaymentLogKeys(days = 30, now: Date = new Date()): string[] {
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    keys.push(paymentLogDailyKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }
  return keys;
}

// 'pending': broadcast 済だが未確定 (EIP-3009 relay の receipt timeout 等)。確定したら
// Explorer / 再照合で success/reverted に解決する想定 (現状は手動確認)。
export type PaymentResult = 'success' | 'reverted' | 'error' | 'pending';
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

// gasless 経路の paymaster 系統 (Circle Paymaster 並行対応・Phase1)。
// standard / cross-chain では undefined。**本型が SoT** で lib/history.ts の
// HistoryProvider が alias する (history→paymentLog の一方向 import・循環なし)。
export type PaymentProvider = 'pimlico' | 'circle';
// circlePaymasterNetUsdc の検証ステータス。**本型が SoT** (history CircleVerification が alias)。
export type CircleVerificationStatus =
  | 'verified'
  | 'client-reported'
  | 'unreconciled';

// client (ブラウザ) が log API に申告してよい検証ステータス。'verified' は server 側
// verifier (verifyCircleReceiptOnChain) のみが付与でき、client 申告は forge 扱いで拒否する。
// CircleVerificationStatus に状態を足したとき route が自動追従するよう Exclude で導出する。
export type ClientReportedCircleVerification = Exclude<
  CircleVerificationStatus,
  'verified'
>;

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
  // 売上総額 (gross・raw)。feeAmount / ガス / split 控除前で GMV 集計の基礎。
  saleAmount?: string;
  // ネットワーク手数料相当額 (raw・支払トークン単位)。全 gasless 経路横断の統一項目。
  // circle 経路は検証ステータス付きで circlePaymasterNetUsdc 側に保持するため省略。
  networkFeeEquivalent?: string;
  // fee/gas 内訳の版 (LOG_FEE_BREAKDOWN_VERSION)。持たない旧 log は内訳不明。
  feeBreakdownVersion?: number;
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
  // --- cross-chain (CCTP V2 / Gateway) の会計フィールド。全て **unreconciled** (reported)。 ---
  // bridge に渡す intent (= gross - OpenPay 利用料)。bridge が fee を deduct する前の値で、
  // 実着金 (minted) は未確定 (B-3 で mint receipt 照合)。settled income ではないため
  // stats は totalMerchantWei に計上しない (bridge marker で除外)。
  bridgedAmount?: string;
  // bridge fee の **上限** (maxFee ceiling・実 charge ではない・実 fee ≤ これ)。
  bridgeFeeMax?: string;
  // cross-chain (CCTP) の source burn tx hash (照合用)。Gateway は burn-intent モデルで undefined。
  burnTxHash?: Hex;
  // --- Circle Paymaster 監査 (gasless circle 経路のみ・C2/C3) ---
  // paymaster 系統。gasless で 'pimlico' | 'circle'、standard/cross-chain は undefined。
  provider?: PaymentProvider;
  // Circle paymaster (permit spender) アドレス。circle 経路のみ。
  circlePaymasterAddress?: Address;
  // Circle が postOp で徴収した net USDC (raw)。client 申告 (verifier が後で再計算)。
  circlePaymasterNetUsdc?: string;
  // 上記 net の検証ステータス。client 経路は通常 'client-reported'。
  circleVerification?: CircleVerificationStatus;
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
  // 売上総額 (gross)。sale を伴う flow で設定。
  saleAmount?: bigint;
  // ネットワーク手数料相当額 (非 circle の gasless 経路)。
  networkFeeEquivalent?: bigint;
  // cross-chain で利用料を別 tx で着金させた場合の fee mint tx hash (監査用)。
  feeTxHash?: Hex;
  // cross-chain bridge 経由の場合のみ指定。direct (= 既存単一 chain) では undefined。
  bridge?: PaymentBridge;
  sourceChainId?: number;
  // cross-chain 会計フィールド (unreconciled・reported)。詳細は PaymentLogEvent 参照。
  bridgedAmount?: bigint;
  bridgeFeeMax?: bigint;
  burnTxHash?: Hex;
  // Circle Paymaster 経路の監査フィールド (gasless circle のみ)。
  provider?: PaymentProvider;
  circlePaymasterAddress?: Address;
  circlePaymasterNetUsdc?: string;
  circleVerification?: CircleVerificationStatus;
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
    | { result: 'error'; errorMessage: string; txHash?: Hex; userOpHash?: Hex },
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
    saleAmount: ctx.saleAmount?.toString(),
    networkFeeEquivalent: ctx.networkFeeEquivalent?.toString(),
    feeBreakdownVersion: LOG_FEE_BREAKDOWN_VERSION,
    feeTxHash: ctx.feeTxHash,
    bridge: ctx.bridge,
    sourceChainId: ctx.sourceChainId,
    bridgedAmount: ctx.bridgedAmount?.toString(),
    bridgeFeeMax: ctx.bridgeFeeMax?.toString(),
    burnTxHash: ctx.burnTxHash,
    provider: ctx.provider,
    circlePaymasterAddress: ctx.circlePaymasterAddress,
    circlePaymasterNetUsdc: ctx.circlePaymasterNetUsdc,
    circleVerification: ctx.circleVerification,
  };
  if (outcome.result === 'error') {
    // Circle の確認待ち (CirclePendingError) は broadcast 済 op を持つので userOpHash を
    // 監査に残す (未 retry でも submitted op handle を失わない)。
    return {
      ...base,
      errorMessage: outcome.errorMessage.slice(0, 500),
      txHash: outcome.txHash,
      userOpHash: outcome.userOpHash,
    };
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
