'use client';

// PaymentForm / CheckoutForm の決済結果を LocalStorage 履歴に append する責務を
// 集約する hook。 useBatchPayment (gasless) と useStandardPayment (通常決済)
// の 5 つの状態遷移 — gasless success/revert/error、standard success、
// merchant-error、fee-error — を 1 箇所で観測する。
//
// 重複対策は lib/history.ts 側 (id dedupe) に任せ、ここでは StrictMode の
// 二重 effect / react-query onSuccess 再呼出を素朴に許容する。

import { useEffect, useRef } from 'react';
import type { Address, Hex } from 'viem';
import {
  appendHistory,
  buildHistoryEntry,
  type CircleVerification,
  type HistoryEntry,
  type HistoryLineItem,
  type HistoryProvider,
} from '@/lib/history';
import {
  appendPayerReceipt,
  payerReceiptFromHistoryEntry,
} from '@/lib/payerReceipt';
import type { GasMode, PayMode } from '@/lib/fee';
import type { ChainSlug } from '@/lib/chains';
import type { TokenSymbol } from '@/lib/tokens';
import type { TaxCategory } from '@/lib/tax';

export type AppendPaymentHistoryCtx = {
  chainId: number;
  chainSlug: ChainSlug;
  asset: TokenSymbol;
  tokenAddress: Address;
  payMode: PayMode;
  gasMode: GasMode | null;
  merchant: Address;
  merchantAmount: bigint;
  customer: Address | undefined;
  feeReceiver: Address;
  /** OpenPay 利用手数料 (サービス料) のみ。alpha / 将来とも 0n。 */
  feeAmount: bigint;
  /** 売上総額 (gross・請求額)。手数料 / ガス / split 控除前で GMV 集計の基礎。
   * sale を伴わない leg は null。 */
  saleAmount: bigint | null;
  /** ネットワーク手数料相当額 (非 circle の gasless 経路)。standard / circle は null
   * (circle は result 由来の circlePaymasterNetUsdc を使う)。 */
  networkFeeEquivalent: bigint | null;
  /**
   * 店舗名 — 現状は常に '' を渡す前提。URL params に店舗名 key が無いため
   * parent (PaymentForm / CheckoutForm) から流す source が無い。HistoryEntry の
   * schema 互換性のため field は保持。
   */
  storeName: string;
  note: string;
  /** 異通貨建て決済の anchor (FX 換算 QR のみ非 null)。元の価格建て金額 (人間可読)・
   *  建てトークン・適用 FX レート。通常決済は省略 (= null)。全 sale leg 横断で同一値。 */
  anchorAmount?: string | null;
  anchorSymbol?: TokenSymbol | null;
  fxRateUsdcJpy?: string | null;
  /** v5 記帳補助メタ (商品名/メモ/税率/税区分/管理番号/売上明細)。sale leg のみ記録。
   *  手数料徴収 leg (standard-fee) には付けない (anchor と同じ「sale だけ」規約)。 */
  productName?: string | null;
  memo?: string | null;
  taxRate?: number | null;
  taxCategory?: TaxCategory | null;
  receiptNo?: string | null;
  lineItems?: HistoryLineItem[] | null;
  /** 顧客向け電子レシート (PayerReceipt) を保存する際の発生元 route / locale。
   *  sale 成功 leg のみで使用。store 側 HistoryEntry には影響しない (受領控え専用)。 */
  sourceRoute?: string;
  locale?: string;
};

// sale 成功 leg の HistoryEntry から顧客向け電子レシート (PayerReceipt) を保存する。
// dedupe (receiptId = txHash || userOpHash) は payerReceipt 側が担保。
function saveReceiptFor(entry: HistoryEntry, ctx: AppendPaymentHistoryCtx): void {
  appendPayerReceipt(
    payerReceiptFromHistoryEntry(entry, {
      sourceRoute: ctx.sourceRoute,
      locale: ctx.locale,
    }),
  );
}

// submit 時点で固定したい amount field のみを抜き出した snapshot。tx 完了前に
// 親コンポーネントの state (gas quote refetch / variable amount 編集) が変動しても、
// 履歴 entry には mutate() 呼出時の値を記録するために使う。
type SubmittedAmounts = {
  merchantAmount: bigint;
  feeAmount: bigint;
  // gasless の submit snapshot のみ設定する (standard は未設定 → ctx fallback / 導出)。
  saleAmount?: bigint | null;
  networkFeeEquivalent?: bigint | null;
};

type GaslessSnapshot = {
  data?: {
    // relay の pending (authorizationState 既使用) では txHash 不明 → null 許容。
    txHash: Hex | null;
    // EIP-3009 relay は ERC-4337 を経由しない (userOp 無し)・Gelato は receipt block を
    // 返さないため、relay 経路では両者 null。useBatchPayment 経路は常に非 null。
    userOpHash: Hex | null;
    blockNumber: bigint | null;
    success: boolean;
    // relay 経路で broadcast 済だが未確定 (receipt timeout 等)。status='pending' で記録。
    pending?: boolean;
    // 監査次元 (useBatchPayment の BatchPaymentResult 由来)。circle 経路のみ非 null。
    provider?: HistoryProvider;
    circlePaymasterAddress?: string;
    circlePaymasterNetUsdc?: string;
    circleVerification?: CircleVerification;
  };
  error: Error | null;
  // react-query useMutation の variables (= mutate() に渡された params)。
  // 完了時 (data/error) effect で参照することで amount drift を避ける。
  variables?: SubmittedAmounts;
};

type StandardSnapshot = {
  data?: {
    merchantTxHash: Hex;
    feeTxHash?: Hex;
    blockNumber: bigint;
  };
  phase: string;
  merchantTxHash?: Hex;
  feeTxHash?: Hex;
  error: Error | null;
  // useStandardPayment.lastSubmittedParams を経由。submit 時点の amount snapshot。
  lastSubmittedParams?: SubmittedAmounts | null;
  // phase が 'success' 以外でも merchant receipt 単独で取得できる block number。
  // fee-error 時の merchant 着金記録に使う。
  merchantBlockNumber?: bigint;
};

export function usePaymentHistory(
  ctx: AppendPaymentHistoryCtx,
  gasless: GaslessSnapshot,
  standard: StandardSnapshot,
): void {
  const gaslessData = gasless.data;
  const gaslessError = gasless.error;
  const gaslessVariables = gasless.variables;
  const standardData = standard.data;
  const standardPhase = standard.phase;
  const standardMerchantTxHash = standard.merchantTxHash;
  const standardFeeTxHash = standard.feeTxHash;
  const standardError = standard.error;
  const standardSubmittedParams = standard.lastSubmittedParams;
  const standardMerchantBlockNumber = standard.merchantBlockNumber;
  // gasless/relay の throw 系エラーは txHash を持たないため id dedupe が効かず、ctx 変化で
  // effect が再実行されると重複 append される (Codex A2 P3)。Error オブジェクト identity で
  // 1 回に絞る (react-query は次の mutation まで同一 Error 参照を保持する)。
  const appendedErrorRef = useRef<Error | null>(null);

  // R: gas quote 30s refetch / variable-amount /pay の編集で receipt 到達時に
  //    ctx.merchantAmount / ctx.feeAmount が drift する race を回避するため、
  //    submitted snapshot (mutation.variables / lastSubmittedParams) があれば
  //    それを優先する。snapshot 不在時は ctx fallback (e.g. 旧 test 互換)。
  const gaslessMerchantAmount =
    gaslessVariables?.merchantAmount ?? ctx.merchantAmount;
  const gaslessFeeAmount = gaslessVariables?.feeAmount ?? ctx.feeAmount;
  const gaslessSaleAmount = gaslessVariables?.saleAmount ?? ctx.saleAmount;
  const gaslessNetworkFee =
    gaslessVariables?.networkFeeEquivalent ?? ctx.networkFeeEquivalent;
  const standardMerchantAmount =
    standardSubmittedParams?.merchantAmount ?? ctx.merchantAmount;
  const standardFeeAmount =
    standardSubmittedParams?.feeAmount ?? ctx.feeAmount;
  // standard は gas 概念が無い。売上総額は submit snapshot (merchant 着金 + 手数料) から
  // 復元して drift を避ける (手数料 = 0 の現状は merchantAmount に一致)。snapshot 不在の
  // 旧 test 互換では ctx.saleAmount に fallback。
  const standardSaleAmount =
    standardSubmittedParams != null
      ? standardSubmittedParams.merchantAmount + standardSubmittedParams.feeAmount
      : ctx.saleAmount;

  // 異通貨建ての anchor (ctx.anchor*) は各 sale leg の buildHistoryEntry で直接読む
  // (手数料徴収 leg = standard-fee は sale ではないため付けない)。

  // gasless 成功 (revert / pending 含む)。data.success===false (チェーン上 revert) は
  // status='reverted'、relay の未確定は status='pending' で記録 → Explorer で追跡可能。
  // pending かつ txHash 無し (authorizationState 既使用 = 既に処理済) は、元の submission が
  // 既に記録済のため重複記録しない。
  useEffect(() => {
    if (!gaslessData) return;
    if (gaslessData.pending && !gaslessData.txHash) return;
    const status = gaslessData.pending
      ? ('pending' as const)
      : gaslessData.success
        ? ('success' as const)
        : ('reverted' as const);
    const entry = buildHistoryEntry({
      flow: 'batch',
      status,
      chainId: ctx.chainId,
      chainSlug: ctx.chainSlug,
      asset: ctx.asset,
      tokenAddress: ctx.tokenAddress,
      payMode: 'gasless',
      gasMode: ctx.gasMode,
      merchant: ctx.merchant,
      merchantAmount: gaslessMerchantAmount,
      customer: ctx.customer,
      feeReceiver: ctx.feeReceiver,
      feeAmount: gaslessFeeAmount,
      saleAmount: gaslessSaleAmount,
      // circle はネットワーク手数料を検証ステータス付きで circlePaymasterNetUsdc に
      // 持つため networkFeeEquivalent は null (表示/集計は networkFeeEquivalentOf が coalesce)。
      networkFeeEquivalent:
        gaslessData.provider === 'circle' ? null : gaslessNetworkFee,
      txHash: gaslessData.txHash,
      userOpHash: gaslessData.userOpHash,
      blockNumber: gaslessData.blockNumber,
      errorMessage: null,
      storeName: ctx.storeName,
      note: ctx.note,
      provider: gaslessData.provider ?? null,
      circlePaymasterAddress: gaslessData.circlePaymasterAddress ?? null,
      circlePaymasterNetUsdc: gaslessData.circlePaymasterNetUsdc ?? null,
      circleVerification: gaslessData.circleVerification ?? null,
      anchorAmount: ctx.anchorAmount ?? null,
      anchorSymbol: ctx.anchorSymbol ?? null,
      fxRateUsdcJpy: ctx.fxRateUsdcJpy ?? null,
      productName: ctx.productName ?? null,
      memo: ctx.memo ?? null,
      taxRate: ctx.taxRate ?? null,
      taxCategory: ctx.taxCategory ?? null,
      receiptNo: ctx.receiptNo ?? null,
      lineItems: ctx.lineItems ?? null,
    });
    appendHistory(entry);
    // 顧客向け電子レシート: 成功 / relay pending のみ控えを残す (reverted は控えない)。
    if (status !== 'reverted') saveReceiptFor(entry, ctx);
  }, [
    gaslessData,
    gaslessMerchantAmount,
    gaslessFeeAmount,
    gaslessSaleAmount,
    gaslessNetworkFee,
    ctx,
  ]);

  // gasless: throw 系エラー (paymaster reject / RPC 障害 / 残高不足 等)。
  // tx hash が無い時の dedupe 規則は buildHistoryEntry の id 生成 (秒+msg seed) に依存。
  useEffect(() => {
    if (!gaslessError) return;
    if (appendedErrorRef.current === gaslessError) return;
    appendedErrorRef.current = gaslessError;
    appendHistory(
      buildHistoryEntry({
        flow: 'batch',
        status: 'error',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'gasless',
        gasMode: ctx.gasMode,
        merchant: ctx.merchant,
        merchantAmount: gaslessMerchantAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: gaslessFeeAmount,
        saleAmount: gaslessSaleAmount,
        // throw 系エラーは tx 未確定で provider 不明。ctx/variables が circle 経路で
        // null を渡すため、非 circle の試行値のみが入る。
        networkFeeEquivalent: gaslessNetworkFee,
        txHash: null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: gaslessError.message,
        storeName: ctx.storeName,
        note: ctx.note,
        anchorAmount: ctx.anchorAmount ?? null,
        anchorSymbol: ctx.anchorSymbol ?? null,
        fxRateUsdcJpy: ctx.fxRateUsdcJpy ?? null,
        productName: ctx.productName ?? null,
        memo: ctx.memo ?? null,
        taxRate: ctx.taxRate ?? null,
        taxCategory: ctx.taxCategory ?? null,
        receiptNo: ctx.receiptNo ?? null,
        lineItems: ctx.lineItems ?? null,
      }),
    );
  }, [
    gaslessError,
    gaslessMerchantAmount,
    gaslessFeeAmount,
    gaslessSaleAmount,
    gaslessNetworkFee,
    ctx,
  ]);

  // standard 成功: merchant tx は必ず append。fee tx は feeTxHash があれば
  // 2 件目として append (会計上 「店舗着金 X + 手数料 Y」を分離記録)。
  useEffect(() => {
    if (!standardData) return;
    const entry = buildHistoryEntry({
      flow: 'standard-merchant',
      status: 'success',
      chainId: ctx.chainId,
      chainSlug: ctx.chainSlug,
      asset: ctx.asset,
      tokenAddress: ctx.tokenAddress,
      payMode: 'standard',
      gasMode: null,
      merchant: ctx.merchant,
      merchantAmount: standardMerchantAmount,
      customer: ctx.customer,
      feeReceiver: ctx.feeReceiver,
      feeAmount: standardFeeAmount,
      saleAmount: standardSaleAmount,
      // standard は OpenPay が gas に touch しない (顧客 wallet が native で別建て負担)。
      networkFeeEquivalent: null,
      txHash: standardData.merchantTxHash,
      userOpHash: null,
      blockNumber: standardData.blockNumber,
      errorMessage: null,
      storeName: ctx.storeName,
      note: ctx.note,
      anchorAmount: ctx.anchorAmount ?? null,
      anchorSymbol: ctx.anchorSymbol ?? null,
      fxRateUsdcJpy: ctx.fxRateUsdcJpy ?? null,
      productName: ctx.productName ?? null,
      memo: ctx.memo ?? null,
      taxRate: ctx.taxRate ?? null,
      taxCategory: ctx.taxCategory ?? null,
      receiptNo: ctx.receiptNo ?? null,
      lineItems: ctx.lineItems ?? null,
    });
    appendHistory(entry);
    // 顧客向け電子レシート (店舗着金確定 = sale 成功)。
    saveReceiptFor(entry, ctx);
    if (standardData.feeTxHash) {
      appendHistory(
        buildHistoryEntry({
          flow: 'standard-fee',
          status: 'success',
          chainId: ctx.chainId,
          chainSlug: ctx.chainSlug,
          asset: ctx.asset,
          tokenAddress: ctx.tokenAddress,
          payMode: 'standard',
          gasMode: null,
          merchant: ctx.feeReceiver,
          merchantAmount: standardFeeAmount,
          customer: ctx.customer,
          feeReceiver: ctx.feeReceiver,
          feeAmount: standardFeeAmount,
          // 手数料徴収 leg は売上ではないため saleAmount=null (GMV に二重計上しない)。
          saleAmount: null,
          networkFeeEquivalent: null,
          txHash: standardData.feeTxHash,
          userOpHash: null,
          blockNumber: standardData.blockNumber,
          errorMessage: null,
          storeName: ctx.storeName,
          note: ctx.note,
        }),
      );
    }
  }, [
    standardData,
    standardMerchantAmount,
    standardFeeAmount,
    standardSaleAmount,
    ctx,
  ]);

  // standard merchant-error: merchant 送金が失敗 (fee は未送信)。
  // wallet が tx 送信したが revert したケースは merchantTxHash あり、
  // wallet がそもそも sign 拒否したケースは merchantTxHash なし。
  //
  // errorMessage は実 Error.message のみを保存し、ない場合は null。
  // 「失敗した phase」自体は HistoryEntry.flow ('standard-merchant') と
  // .status ('error') で識別できるため、UI / CSV に phase 名を error 文と
  // して埋め込む必要はない (むしろ店主にとって意味不明な文字列になる)。
  useEffect(() => {
    if (standardPhase !== 'merchant-error') return;
    appendHistory(
      buildHistoryEntry({
        flow: 'standard-merchant',
        status: 'error',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'standard',
        gasMode: null,
        merchant: ctx.merchant,
        merchantAmount: standardMerchantAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: standardFeeAmount,
        saleAmount: standardSaleAmount,
        networkFeeEquivalent: null,
        txHash: standardMerchantTxHash ?? null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: standardError?.message ?? null,
        storeName: ctx.storeName,
        note: ctx.note,
        anchorAmount: ctx.anchorAmount ?? null,
        anchorSymbol: ctx.anchorSymbol ?? null,
        fxRateUsdcJpy: ctx.fxRateUsdcJpy ?? null,
        productName: ctx.productName ?? null,
        memo: ctx.memo ?? null,
        taxRate: ctx.taxRate ?? null,
        taxCategory: ctx.taxCategory ?? null,
        receiptNo: ctx.receiptNo ?? null,
        lineItems: ctx.lineItems ?? null,
      }),
    );
  }, [
    standardPhase,
    standardMerchantTxHash,
    standardError,
    standardMerchantAmount,
    standardFeeAmount,
    standardSaleAmount,
    ctx,
  ]);

  // standard fee-error: merchant 確定済 (着金 OK) + fee tx だけ失敗。
  // 会計上は「fee 未収」の状態として明示記録 (retry UI が出る)。
  //
  // R: useStandardPayment.data は phase==='success' でのみ undefined 以外を返す
  //    設計のため、fee-error 時に通常の "standard success" effect は走らない。
  //    結果として店主視点で「お金を受け取った」事実が履歴に残らない欠陥が出る。
  //    ここで merchant receipt 単独 (merchantTxHash + merchantBlockNumber) が
  //    揃っていれば merchant-success 行を 1 件補完で append し、その後 fee-error
  //    行を append する。merchant 着金は確定済 = 会計上必ず計上すべき事象。
  useEffect(() => {
    if (standardPhase !== 'fee-error') return;
    if (standardMerchantTxHash && standardMerchantBlockNumber !== undefined) {
      const entry = buildHistoryEntry({
        flow: 'standard-merchant',
        status: 'success',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'standard',
        gasMode: null,
        merchant: ctx.merchant,
        merchantAmount: standardMerchantAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: standardFeeAmount,
        saleAmount: standardSaleAmount,
        networkFeeEquivalent: null,
        txHash: standardMerchantTxHash,
        userOpHash: null,
        blockNumber: standardMerchantBlockNumber,
        errorMessage: null,
        storeName: ctx.storeName,
        note: ctx.note,
        anchorAmount: ctx.anchorAmount ?? null,
        anchorSymbol: ctx.anchorSymbol ?? null,
        fxRateUsdcJpy: ctx.fxRateUsdcJpy ?? null,
        productName: ctx.productName ?? null,
        memo: ctx.memo ?? null,
        taxRate: ctx.taxRate ?? null,
        taxCategory: ctx.taxCategory ?? null,
        receiptNo: ctx.receiptNo ?? null,
        lineItems: ctx.lineItems ?? null,
      });
      appendHistory(entry);
      // fee は失敗したが店舗着金は確定 = 顧客にとっては支払い成立。控えを残す。
      saveReceiptFor(entry, ctx);
    }
    appendHistory(
      buildHistoryEntry({
        flow: 'standard-fee',
        status: 'error',
        chainId: ctx.chainId,
        chainSlug: ctx.chainSlug,
        asset: ctx.asset,
        tokenAddress: ctx.tokenAddress,
        payMode: 'standard',
        gasMode: null,
        merchant: ctx.feeReceiver,
        merchantAmount: standardFeeAmount,
        customer: ctx.customer,
        feeReceiver: ctx.feeReceiver,
        feeAmount: standardFeeAmount,
        saleAmount: null,
        networkFeeEquivalent: null,
        txHash: standardFeeTxHash ?? null,
        userOpHash: null,
        blockNumber: null,
        errorMessage: standardError?.message ?? null,
        storeName: ctx.storeName,
        note: ctx.note,
      }),
    );
  }, [
    standardPhase,
    standardMerchantTxHash,
    standardMerchantBlockNumber,
    standardFeeTxHash,
    standardError,
    standardMerchantAmount,
    standardFeeAmount,
    standardSaleAmount,
    ctx,
  ]);
}
