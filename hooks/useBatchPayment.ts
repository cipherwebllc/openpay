'use client';

// 店主送金 + (feeReceiver 集約額 > 0 のときに) operator 宛 ERC20 transfer を 1 UserOp
// にバッチ化し、片方だけ成功する中間状態を排除する。
//
// OpenPay 利用手数料 (calcFee = feeAmount) は alpha / 将来とも 0n (決済額非連動・収益化は
// 周辺機能の月額/利用権で決済フロー非経由)。よって feeReceiver への transfer が載るのは
// JPYC sponsorship の gas 立替回収 (gasReimbursement) があるときで、利用手数料 + 立替回収
// (feeAmount + gasReimbursement) を 1 件の transfer に合算する。erc20 / circle は paymaster が
// 顧客から gas を直接徴収するため gasReimbursement=0 = feeReceiver transfer なし。
//
// gas ceiling は両 mode で適用:
//   - sponsorship mode: 運営の赤字回避 (フロア手数料が gas spike を吸収できない)
//   - erc20 mode: 顧客の USDC 出費上限の保護 (Base 1 gwei = 約 1.6 USDC、
//     spike 時の高額決済を防ぐ)
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { useSmartAccount } from './useSmartAccount';
// Circle 経路の重い実装 (getCircleUserOpGasPrice / executeCirclePayment / verifyCircleReceiptOnChain)
// は runCirclePayment 内で **dynamic import** し、/pay /checkout の baseline bundle から外す
// (bundle budget /pay 420kB を超えないため・circle 決済実行時のみロード)。型のみ静的 import。
import type { CircleSmartAccountBundle } from '@/lib/smartAccount/circleAccount';
import type { ConnectedWalletClient } from '@/lib/smartAccount/simpleAccount';
import type { PublicClient } from 'viem';
import { assertGasCeiling } from '@/lib/gasCeiling';
import { resolveNativeJpycRate } from '@/lib/gasReimbursement';
import { logger } from '@/lib/logger';
import {
  buildPaymentLogEvent,
  logPaymentEvent,
  type PaymentLogContext,
  type PaymentProvider,
  type CircleVerificationStatus,
} from '@/lib/paymentLog';
import { resolvePaymasterMode } from '@/lib/pimlico';
// 送信を分ける部品と intent の関所 (lib/smartAccount/pimlicoIntent.ts・pimlicoSend.ts) は、Pimlico の経路で使うときに
// dynamic import する (Circle の部品と同じ方針・/pay /checkout /tip /[handle] の baseline bundle から外す)。型だけ静的に読む。
import type {
  PimlicoIntentHost,
  PimlicoIntentRecord,
  PimlicoPersistResult,
  PimlicoReceipt,
  PimlicoSendLedger,
} from '@/lib/smartAccount/pimlicoIntent';
import type { SignedSendClient } from '@/lib/smartAccount/pimlicoSend';
// 記録の「同じ intent」「同じ版」の定義 (import の無い小さな module・intent の関所と共有する)。
import { isSameIntent, isSameVersion } from '@/lib/smartAccount/pimlicoIntentOwner';
import type { SmartAccountBundle } from '@/lib/smartAccount/simpleAccount';
import type { TokenDeployment } from '@/lib/tokens';

type BatchPaymentParams = {
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: bigint;
  feeReceiver: Address;
  // OpenPay 利用手数料 (サービス料) のみ。alpha / 将来とも 0n。
  feeAmount: bigint;
  // ネットワーク手数料の立替回収分 (JPYC sponsorship のみ > 0)。feeReceiver への on-chain
  // transfer は feeAmount + gasReimbursement の合算。erc20 / circle は paymaster が顧客から
  // 直接徴収するため 0。sponsorship 収支突合 (reconcileSponsorshipGas) もこの値で行う。
  gasReimbursement?: bigint;
  // --- 履歴 / KV log の会計記録用 (on-chain transfer には影響しない) ---
  // 売上総額 (gross・請求額)。GMV 集計の基礎として log に残す。
  saleAmount?: bigint;
  // ネットワーク手数料相当額 (非 circle の gasless 経路の記録値・raw)。circle は receipt 由来の
  // circlePaymasterNetUsdc を検証ステータス付きで使うため未指定 (表示/集計側で coalesce)。
  networkFeeEquivalent?: bigint;
  // 主受取人 (merchant) に加えて、追加の受取人 N 人へ同一トークンを transfer。
  // calcSplitBreakdown が計算した primary 以外の entries を渡す想定。
  // 各 amount > 0 を assertion (split で 0 になる極小ケースは UI 側で弾く前提)。
  extraRecipients?: ReadonlyArray<{ to: Address; amount: bigint }>;
  // --- Circle Paymaster (USDC ガスレス) 経路用 (provider==='circle' のときのみ) ---
  // permit allowance の上限 (gas 実費 + per-chain surcharge を賄う額)。useGasQuoteCircle
  // (chunk5) が算定して渡す。Circle 経路で未指定なら送信を拒否する (過少 → AA revert、
  // 過大 → 過剰 allowance のため、必ず quote 由来の確定値を要求する)。
  circlePermitAmount?: bigint;
  // 1 回の「支払う」操作で固定の冪等試行 ID (retry で不変)。未指定なら mutationFn が
  // 採番する (同一試行内の crash recovery は callHash スキャンで担保される)。
  paymentAttemptId?: string;
};

type BatchPaymentResult = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  // UserOp が実際に消費した native gas コスト (wei)。sponsorship 収支の突合に使う。
  actualGasCost: bigint;
  // --- 監査次元 (provider/Circle) ---
  provider: PaymentProvider;
  // 以下は circle 経路のみ。usePaymentHistory / paymentLog が監査に使う。
  circlePaymasterAddress?: Address;
  // client が receipt から再計算した net USDC (raw・client-reported)。verify 失敗時は undefined。
  circlePaymasterNetUsdc?: string;
  circleVerification?: CircleVerificationStatus;
};

export const PIMLICO_PENDING_KEY_PREFIX = 'openpay.pimlico.pending.';
const PIMLICO_PENDING_SCHEMA_VERSION = 1 as const;

// pending record の最大保持期間 (updatedAt 起点)。bundler が UserOp を drop して永久に
// mine されない場合、latch だけが残って gasless 決済が恒久ロックされる。7 日 = Circle の
// 未決済 attestation 保持期間に合わせた上限で、(a) bundler は drop 後も数日単位で再送を
// 試みうる、(b) UserOp の nonce は新しい op と一意性が保証されない — の 2 点から、24h では
// 「まだ mine されうる op」を先に捨てて二重送金を許す窓ができる。
// 送信の控え (send) の無い record (この欄を足す前の記録・MAv2 の facade で送った記録) は、これを過ぎたら
// 読み出し時に無視 + 破棄する (今までどおり・nonce を読めないので照合できない)。
// 送信の控えのある record は読み出し時に黙って消さない (第 10 回レビュー A-1 の c4・c5): 保存の期限は署名を取り消さず、
// 実行されなかった証拠にもならない。期限を過ぎた記録も開いたまま復元し、次に確かめるとき、候補の receipt と
// EntryPoint の nonce を照合する。候補に receipt があれば確定 (c1)。receipt が無ければ、nonce が未使用 (c4) でも
// 使われていても (c5・候補はもう実行されないが、払い済みだった可能性は残る) 記録を消したと確かめてから閉じる
// (lib/smartAccount/pimlicoIntent.ts の resolveOpenIntent)。照合に要る RPC が読めないときは閉じない。
const PIMLICO_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isPendingExpired(record: { updatedAt: number }): boolean {
  return Date.now() - record.updatedAt > PIMLICO_PENDING_MAX_AGE_MS;
}

type StoredBatchPaymentParams = {
  tokenAddress: Address;
  merchant: Address;
  merchantAmount: string;
  feeReceiver: Address;
  feeAmount: string;
  gasReimbursement?: string;
  saleAmount?: string;
  networkFeeEquivalent?: string;
  extraRecipients?: Array<{ to: Address; amount: string }>;
};

// 記録の形は intent の関所 (lib/smartAccount/pimlicoIntent.ts) と共有する。送信の控え (send) は第 10 回レビュー A-1 で
// 足した任意の欄で、これが無い記録 (この欄を足す前に書かれた記録・MAv2 の facade で送った記録) は今までどおり hash の
// receipt の照会だけで扱う。
type PimlicoPendingRecord = PimlicoIntentRecord<StoredBatchPaymentParams>;

type LedgerPimlicoPendingRecord = PimlicoPendingRecord & {
  send: PimlicoSendLedger;
};

function hasSendLedger(
  record: PimlicoPendingRecord,
): record is LedgerPimlicoPendingRecord {
  return record.send !== undefined;
}

type LatchedPimlicoPending = {
  storageKey: string;
  record: PimlicoPendingRecord;
};

/** bundler が UserOp を受理した後、receipt の応答だけを確認できない状態。
 * relay の RelayResponseUnknownError と同じ `response-unknown` 語彙を使い、通常の
 * payment error / 新規 UserOp retry と区別する。 */
export class PimlicoResponseUnknownError extends Error {
  readonly userOpHash: Hex;
  readonly callFingerprint: Hex;
  readonly reason: string;

  constructor(args: {
    userOpHash: Hex;
    callFingerprint: Hex;
    reason: string;
  }) {
    super('response-unknown');
    this.name = 'PimlicoResponseUnknownError';
    this.userOpHash = args.userOpHash;
    this.callFingerprint = args.callFingerprint;
    this.reason = args.reason;
  }
}

/** pending record store (localStorage) 自体が読めない状態。未解決 UserOp の有無を
 * 判定できないため gasless 送信を fail-closed で止める (lib/circlePending の
 * requireStorage と同じ方針)。何の波及を断つか: storage 障害で latch を失った端末が、
 * broadcast 済 UserOp の上に 2 本目を重ねる二重支払いを断つ。 */
export class PimlicoPendingStoreUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super('pending-store-unavailable');
    this.name = 'PimlicoPendingStoreUnavailableError';
    this.reason = reason;
  }
}

/** 保存から 7 日を過ぎた intent を、照合 (候補に receipt が無く、EntryPoint の nonce も未使用) で閉じた (c4)。
 * 支払いの失敗ではないので画面の error には出さない (フォームは通常の入力に戻り、新しい支払いができる)。
 * onError の payment log には残る。 */
export class PimlicoIntentClosedError extends Error {
  constructor() {
    super('intent-closed');
    this.name = 'PimlicoIntentClosedError';
  }
}

function pendingStorageKey(args: {
  chainId: number;
  customer: Address | undefined;
  tokenAddress: Address;
}): string {
  return (
    PIMLICO_PENDING_KEY_PREFIX +
    [
      args.chainId,
      args.customer?.toLowerCase() ?? 'disconnected',
      args.tokenAddress.toLowerCase(),
    ].join(':')
  );
}

function fingerprintTransferCalls(
  calls: ReadonlyArray<{ to: Address; data: Hex }>,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'to', type: 'address' },
            { name: 'data', type: 'bytes' },
            { name: 'value', type: 'uint256' },
          ],
        },
      ],
      [
        calls.map((call) => ({
          to: call.to,
          data: call.data,
          value: 0n,
        })),
      ],
    ),
  );
}

// 支払いの内容 (calls) の fingerprint。成功の表示の帰属だけに使う。calls を組めない params (送金額 0) は
// mutationFn 自身が error にするので、ここでは帰属できないもの (null) として扱う。
function attemptFingerprint(params: BatchPaymentParams): Hex | null {
  try {
    return fingerprintTransferCalls(buildTransferCalls(params));
  } catch {
    return null;
  }
}

function serializeBatchPaymentParams(
  params: BatchPaymentParams,
): StoredBatchPaymentParams {
  return {
    tokenAddress: params.tokenAddress,
    merchant: params.merchant,
    merchantAmount: params.merchantAmount.toString(),
    feeReceiver: params.feeReceiver,
    feeAmount: params.feeAmount.toString(),
    ...(params.gasReimbursement === undefined
      ? {}
      : { gasReimbursement: params.gasReimbursement.toString() }),
    ...(params.saleAmount === undefined
      ? {}
      : { saleAmount: params.saleAmount.toString() }),
    ...(params.networkFeeEquivalent === undefined
      ? {}
      : { networkFeeEquivalent: params.networkFeeEquivalent.toString() }),
    ...(params.extraRecipients === undefined
      ? {}
      : {
          extraRecipients: params.extraRecipients.map((recipient) => ({
            to: recipient.to,
            amount: recipient.amount.toString(),
          })),
        }),
  };
}

function deserializeBatchPaymentParams(
  params: StoredBatchPaymentParams,
): BatchPaymentParams {
  return {
    tokenAddress: params.tokenAddress,
    merchant: params.merchant,
    merchantAmount: BigInt(params.merchantAmount),
    feeReceiver: params.feeReceiver,
    feeAmount: BigInt(params.feeAmount),
    ...(params.gasReimbursement === undefined
      ? {}
      : { gasReimbursement: BigInt(params.gasReimbursement) }),
    ...(params.saleAmount === undefined
      ? {}
      : { saleAmount: BigInt(params.saleAmount) }),
    ...(params.networkFeeEquivalent === undefined
      ? {}
      : { networkFeeEquivalent: BigInt(params.networkFeeEquivalent) }),
    ...(params.extraRecipients === undefined
      ? {}
      : {
          extraRecipients: params.extraRecipients.map((recipient) => ({
            to: recipient.to,
            amount: BigInt(recipient.amount),
          })),
        }),
  };
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function isStoredBatchPaymentParams(
  value: unknown,
): value is StoredBatchPaymentParams {
  if (value === null || typeof value !== 'object') return false;
  const params = value as Partial<StoredBatchPaymentParams>;
  if (
    !isAddress(params.tokenAddress ?? '') ||
    !isAddress(params.merchant ?? '') ||
    !isDecimal(params.merchantAmount) ||
    !isAddress(params.feeReceiver ?? '') ||
    !isDecimal(params.feeAmount) ||
    (params.gasReimbursement !== undefined &&
      !isDecimal(params.gasReimbursement)) ||
    (params.saleAmount !== undefined && !isDecimal(params.saleAmount)) ||
    (params.networkFeeEquivalent !== undefined &&
      !isDecimal(params.networkFeeEquivalent))
  ) {
    return false;
  }
  return (
    params.extraRecipients === undefined ||
    (Array.isArray(params.extraRecipients) &&
      params.extraRecipients.every(
        (recipient) =>
          recipient !== null &&
          typeof recipient === 'object' &&
          isAddress(recipient.to) &&
          isDecimal(recipient.amount),
      ))
  );
}

function isPimlicoSendLedger(value: unknown): value is PimlicoSendLedger {
  if (value === null || typeof value !== 'object') return false;
  const send = value as Partial<PimlicoSendLedger>;
  return (
    isAddress(send.entryPoint ?? '') &&
    isAddress(send.sender ?? '') &&
    isDecimal(send.nonceKey) &&
    isDecimal(send.nonceSeq) &&
    send.signedUserOp !== null &&
    typeof send.signedUserOp === 'object' &&
    !Array.isArray(send.signedUserOp) &&
    (send.priorUserOpHashes === undefined ||
      (Array.isArray(send.priorUserOpHashes) &&
        send.priorUserOpHashes.every((hash) => isHex(hash, { strict: true }))))
  );
}

function isPimlicoPendingRecord(
  value: unknown,
): value is PimlicoPendingRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<PimlicoPendingRecord>;
  return (
    record.schemaVersion === PIMLICO_PENDING_SCHEMA_VERSION &&
    record.provider === 'pimlico' &&
    (record.status === 'pending' || record.status === 'unknown') &&
    (record.send === undefined || isPimlicoSendLedger(record.send)) &&
    typeof record.chainId === 'number' &&
    Number.isSafeInteger(record.chainId) &&
    typeof record.customer === 'string' &&
    isAddress(record.tokenAddress ?? '') &&
    isHex(record.callFingerprint ?? '', { strict: true }) &&
    isHex(record.userOpHash ?? '', { strict: true }) &&
    isStoredBatchPaymentParams(record.params) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  );
}

// 読み出し結果の 3 状態。'none' (記録なし) と 'unavailable' (storage 自体が読めない) を
// 区別するのが要点 — 従来は両方 null に潰れて fail-open だった。
type PimlicoPendingRead =
  | { kind: 'record'; record: PimlicoPendingRecord }
  | { kind: 'none' }
  | { kind: 'unavailable'; error: unknown };

function readPimlicoPending(storageKey: string): PimlicoPendingRead {
  if (typeof window === 'undefined') return { kind: 'none' };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch (error) {
    // storage が読めない = 未解決 UserOp の有無を判定できない。呼出側は fail-closed で
    // 送信を止める (何の波及を断つか: latch を失った端末の二重送金)。
    logger.warn('pimlico.pending.load-failed', { storageKey, error });
    return { kind: 'unavailable', error };
  }
  if (raw === null) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // corrupt な 1 件は storage 障害ではない。従来どおり「記録なし」に倒して
    // 決済開始を止めない。
    logger.warn('pimlico.pending.load-failed', { storageKey, error });
    return { kind: 'none' };
  }
  if (!isPimlicoPendingRecord(parsed)) {
    logger.warn('pimlico.pending.corrupt-record', { storageKey });
    return { kind: 'none' };
  }
  if (parsed.send === undefined && isPendingExpired(parsed)) {
    // 送信の控えの無い期限切れ = 解決不能になった残骸。無視 + 破棄して恒久ロックアウトを避ける。
    // 控えのある記録は消さない (期限を過ぎても照合するまで開いたまま・PIMLICO_PENDING_MAX_AGE_MS の注記)。
    logger.warn('pimlico.pending.expired', {
      storageKey,
      userOpHash: parsed.userOpHash,
      updatedAt: parsed.updatedAt,
    });
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // 破棄失敗は判定に影響しない (次回読み出しでも expired として無視される)。
    }
    return { kind: 'none' };
  }
  return { kind: 'record', record: parsed };
}

// 保存の結果 (PimlicoPersistResult の 3 つ・lib/smartAccount/pimlicoIntent.ts)。送信の前の保存 (第 10 回レビュー A-1) は
// 'stored' のときだけ送る (pimlicoIntent.ts の sendRecordedOp)。送信の後の更新 (status の書き換え等) は今までどおり送る・
// 送らないの判断に使わない。
function persistPimlicoPending(
  storageKey: string,
  record: PimlicoPendingRecord,
): PimlicoPersistResult {
  if (typeof window === 'undefined') return 'not-stored';
  // storage 障害を broadcast 済み決済の通常 failure へ波及させず、呼出元 hook の
  // memory latch は維持する (同一タブでの二重送金防止を失わない)。
  const warn = (error: unknown) =>
    logger.warn('pimlico.pending.persist-failed', {
      storageKey,
      userOpHash: record.userOpHash,
      error,
    });
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
    window.localStorage.setItem(storageKey, serialized);
  } catch (error) {
    warn(error);
    return 'not-stored';
  }
  try {
    if (window.localStorage.getItem(storageKey) !== serialized) {
      throw new Error('read-back mismatch');
    }
    return 'stored';
  } catch (error) {
    warn(error);
    return 'uncertain';
  }
}

// 記録を消し、消えたことを確かめる (true = この key の記録はもう storage に無い)。intent を閉じるとき (c2・c4) と、
// 送っていない op の記録が残ったかもしれないとき (保存の読み戻しの失敗) に使う。何の波及を断つか: 消えたと確かめないまま
// 閉じると、残った署名済みの op が reload の後に「同じ送信内容を再確認」で送られ、その間に開けた通常決済・別の支払いと
// 二重になる。確かめられないとき、呼び出し側は intent を開いたままにする。
function discardPimlicoPending(storageKey: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.removeItem(storageKey);
    return window.localStorage.getItem(storageKey) === null;
  } catch (error) {
    logger.warn('pimlico.pending.discard-failed', { storageKey, error });
    return false;
  }
}

// 確定した op の記録を片付ける。消すのは storage の記録が同じ intent (isSameIntent) のときだけ: 送信の控えのある記録は nonce が
// 同じなら hash が違っても消す (ほかの画面が同じ nonce で作り直した・hash を直した記録も、この nonce の op が取り込まれた以上
// 終わっている)。別の intent の記録は消さない (第 10 回レビュー PR-02 の Codex レビュー P1)。確定以外の書き込み・削除と違い、
// 版 (isSameVersion) では比べない: ほかの試みが送り直した・作り直した後の記録も、取り込まれた nonce の記録なので閉じる。
function clearPimlicoPending(storageKey: string, record: PimlicoPendingRecord): void {
  if (typeof window === 'undefined') return;
  try {
    const current = readPimlicoPending(storageKey);
    if (current.kind === 'record' && isSameIntent(current.record, record)) {
      window.localStorage.removeItem(storageKey);
    }
  } catch (error) {
    // confirmed/reverted の本体結果へ localStorage housekeeping 障害を波及させない。
    // record が残った場合は安全側の unknown latch として次回 receipt 再照会に収束する。
    logger.warn('pimlico.pending.clear-failed', {
      storageKey,
      userOpHash: record.userOpHash,
      error,
    });
  }
}

export function useBatchPayment(
  deployment: TokenDeployment,
  enabled: boolean = true,
  // Circle 経路を抑止して Pimlico erc20 に固定する。useSmartAccount に伝播させないと、決済実行に使う内部 client が
  // Circle に routing される (表示だけを Pimlico にしても、送信は Circle のまま circlePermitAmount 不在で throw する)。
  // いまは本番の呼び出し元 (PaymentForm・CheckoutForm・TipForm) のどれも渡していない = 3 フォームとも既定の false で、
  // USDC は Circle の経路になりうる (TipForm も circlePermitAmount を渡している)。
  disableCircle: boolean = false,
) {
  const { data: clients } = useSmartAccount(deployment, enabled, disableCircle);
  const { address: customer, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const pimlicoStorageKey = pendingStorageKey({
    chainId: chainId ?? deployment.chainId,
    customer,
    tokenAddress: deployment.address,
  });
  const pendingRef = useRef<LatchedPimlicoPending | null>(null);
  const [unknownPending, setUnknownPending] =
    useState<LatchedPimlicoPending | null>(null);
  // pending store が読めないまま送信要求が来た状態 (fail-closed)。broadcast 済 UserOp の
  // 有無を判定できないので gasless だけを止める。storage が再び読めた時点で解除する。
  // Circle の経路で、タブの対応 (sessionStorage の attemptId) を保存できない端末でも立てる (runCirclePayment・r10-ss)。
  const [pendingStoreUnavailable, setPendingStoreUnavailable] = useState(false);

  useEffect(() => {
    const read = readPimlicoPending(pimlicoStorageKey);
    if (read.kind === 'unavailable') {
      // 読めない間は memory latch を上書きしない (誤って解除すると二重送金へ波及する)。
      return;
    }
    const latched =
      read.kind === 'record'
        ? { storageKey: pimlicoStorageKey, record: read.record }
        : null;
    pendingRef.current = latched;
    // reload 後は前回の receipt waiter が存在しないため、永続 record は pending/unknown
    // どちらでも「結果不確定」として復元する。送信の控えのある記録は、7 日を過ぎていても照合 (c4) までは開いたまま。
    setUnknownPending(latched);
    setPendingStoreUnavailable(false);
  }, [pimlicoStorageKey]);

  // この hook の instance が画面にあるか。何の波及を断つか: 画面を離れた (unmount した) 後も react-query の mutation は走り続け、
  // 離れた後にウォレットの署名が返ると、開き直した画面 (新しい hook) の支払いとは別の nonce の op を保存して送る = 二重払い
  // (第 10 回レビュー A-2)。失効した試みは新しい効果 (署名の要求・保存・削除・送信) を始めない。見る所は mutationFn の先頭と、
  // lib/smartAccount/pimlicoIntent.ts の 4 か所 (host.isAlive)。Circle の経路 (H-V) は runCirclePayment と
  // lib/smartAccount/circleSend.ts の冒頭の「失効」。
  // useLayoutEffect にしない: /pay は <Suspense> の中にあり、再 suspend で隠れた子は layout effect だけが外れる。layout に
  // すると、画面が残っているのに正当な署名を捨てる。StrictMode の mount → unmount → mount は effect が同期で true に戻す。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 試み中の印 (同期)。包みの mutate・mutateAsync と retryReceipt が、react-query に渡す直前に立て、その mutation が終わった
  // とき (成功・失敗・throw のどれでも) に下の onSettled で外す。何の波及を断つか: 同じ描画のうちの二度押し (isPending を描いた
  // 再描画より前の 2 回目) が 2 つ目の mutation を作り、署名の要求が 2 つ出て、両方承認すると別の nonce の op が 2 本成立する
  // (第 10 回レビュー A-3)。isPending は react-query が知らせた後の再描画まで変わらないので、ref で同期に見る
  // (hooks/useJpycEip3009Payment.ts・hooks/useUsageFeePayment.ts と同じ形)。
  const attemptInFlightRef = useRef(false);

  // 確定した Pimlico の記録の chain (settleRetained が残す)。別の intent の確定を、今の画面の chain・token の支払いとして
  // 履歴・控えに書いてよいかを確かめるのに使う (recoveredIntent・第 10 回レビュー A-1 の Codex 第 2 回 MUST 2)。
  const [settledChainId, setSettledChainId] = useState<number | null>(null);

  const mutation = useMutation<BatchPaymentResult, Error, BatchPaymentParams>({
    mutationFn: async (params) => {
      // 失効した試みは始めない (provider によらない: Pimlico・Circle・MAv2)。何の波及を断つか: mutate と同じ tick に unmount した
      // 試み・offline で止まり unmount の後に再開した試みが、開き直した画面の後ろで、送り直しの保存・期限で閉じる削除・新しい
      // 署名の要求へ進むこと。この先は何も読まず・書かず・求めない (relay の hook の入口と同じ文字列)。
      if (!mountedRef.current) throw new Error('payment_cancelled');
      // memory の記録を差し替える。応答不明として画面に出す記録なら、画面の hash も合わせる。
      const holdRecord = (record: PimlicoPendingRecord, latched: boolean) => {
        const held = { storageKey: pimlicoStorageKey, record };
        pendingRef.current = held;
        if (latched) setUnknownPending(held);
      };

      // memory と画面のラッチがこの記録なら外す。
      const releaseRecord = (record: PimlicoPendingRecord) => {
        if (
          pendingRef.current?.storageKey === pimlicoStorageKey &&
          pendingRef.current.record.userOpHash === record.userOpHash
        ) {
          pendingRef.current = null;
        }
        setUnknownPending((current) =>
          current?.storageKey === pimlicoStorageKey &&
          current.record.userOpHash === record.userOpHash
            ? null
            : current,
        );
      };

      // receipt が取れた op で記録を閉じる。userOpHash は receipt が見つかった op の hash
      // (同じ nonce で作り直す前の op が取り込まれたときは、記録の今の hash と違う)。
      const settleRetained = (
        record: PimlicoPendingRecord,
        userOpHash: Hex,
        receipt: PimlicoReceipt,
      ): BatchPaymentResult => {
        // success / reverted の receipt 判定は従来どおり。どちらも on-chain 終端なので
        // unknown latch を解除し、次回の正規決済だけを許可する。
        clearPimlicoPending(pimlicoStorageKey, record);
        releaseRecord(record);
        setSettledChainId(record.chainId);
        return {
          userOpHash,
          txHash: receipt.receipt.transactionHash,
          blockNumber: receipt.receipt.blockNumber,
          success: receipt.success,
          actualGasCost: receipt.actualGasCost,
          provider: 'pimlico' as const,
        };
      };

      const waitForRetainedReceipt = async (
        pimlicoClient: SmartAccountBundle['pimlicoClient'],
        record: PimlicoPendingRecord,
      ): Promise<BatchPaymentResult> => {
        let receipt: Awaited<
          ReturnType<typeof pimlicoClient.waitForUserOperationReceipt>
        >;
        try {
          receipt = await pimlicoClient.waitForUserOperationReceipt({
            hash: record.userOpHash,
          });
        } catch (error) {
          const unknownRecord: PimlicoPendingRecord = {
            ...record,
            status: 'unknown',
            updatedAt: Date.now(),
          };
          const latched = {
            storageKey: pimlicoStorageKey,
            record: unknownRecord,
          };
          pendingRef.current = latched;
          setUnknownPending(latched);
          // storage の記録が、この試みが書いた (読んだ) 版のときだけ書く (待つ間にほかの画面が閉じた記録を復活させない・別の支払いや
          // ほかの試みが書き直した記録を古い写しで上書きしない・第 10 回レビュー PR-02 の Codex レビュー)。控えの無い記録は
          // updatedAt を期限の基準にする (readPimlicoPending) ので、ここで今の時刻にするのは今までどおり期限を先へ延ばす側だけ
          // (版が同じ = storage の時刻はこの試みの時刻なので、巻き戻らない)。memory のラッチと応答不明の終わり方は同じ。
          const current = readPimlicoPending(pimlicoStorageKey);
          if (current.kind === 'record' && isSameVersion(current.record, record)) {
            persistPimlicoPending(pimlicoStorageKey, unknownRecord);
          }
          logger.warn('pimlico.receipt.response-unknown', {
            userOpHash: record.userOpHash,
            callFingerprint: record.callFingerprint,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new PimlicoResponseUnknownError({
            userOpHash: record.userOpHash,
            callFingerprint: record.callFingerprint,
            reason: error instanceof Error ? error.message : String(error),
          });
        }

        return settleRetained(record, record.userOpHash, receipt);
      };

      // 送れる手段 (今の Pimlico の bundle の、送信を分けられる client と、送った後に receipt を待つ bundler の client)。
      const senderOf = (bundle: SmartAccountBundle, client: SignedSendClient) => ({
        client,
        bundler: bundle.pimlicoClient,
      });

      // intent の関所 (lib/smartAccount/pimlicoIntent.ts) へ渡す、storage・ラッチ・error の型。
      // bundle が無い (今の account の Pimlico の bundle が無い) ときは照合だけ (送らない)。
      const intentHost = (
        bundle: SmartAccountBundle | null,
        sender: ReturnType<typeof senderOf> | null,
      ): PimlicoIntentHost<StoredBatchPaymentParams, BatchPaymentResult> => ({
        storageKey: pimlicoStorageKey,
        bundler: bundle?.pimlicoClient ?? null,
        publicClient,
        sender,
        isAlive: () => mountedRef.current,
        isExpired: isPendingExpired,
        read: () => readPimlicoPending(pimlicoStorageKey),
        persist: (record) => persistPimlicoPending(pimlicoStorageKey, record),
        discard: () => discardPimlicoPending(pimlicoStorageKey),
        hold: holdRecord,
        release: releaseRecord,
        setStoreUnavailable: setPendingStoreUnavailable,
        settle: settleRetained,
        unknownError: (record, reason) =>
          new PimlicoResponseUnknownError({
            userOpHash: record.userOpHash,
            callFingerprint: record.callFingerprint,
            reason,
          }),
        storeUnavailableError: () =>
          new PimlicoPendingStoreUnavailableError('persist-failed'),
        closedError: () => new PimlicoIntentClosedError(),
      });

      // 開いている intent への入口 (ここ 1 か所・第 10 回レビュー A-1)。記録は部品の読み込みより先にラッチする (読み込みに
      // 失敗しても、別の支払い・通常決済を開けない)。内容 (calls) が記録と違えば、何も読まず・送らずに止める (別 payment intent
      // への再署名・broadcast を未解決 UserOp から遮断する)。照合・閉じる・送り直す・作り直すの判断は pimlicoIntent.ts の
      // resolveOpenIntent だけが行う。bundle = 今の Pimlico の bundle (null = 今の account では送れない: Smart Account が無い・
      // Circle の経路。照合 (読むだけ) は行う)。
      const openIntent = async (
        record: PimlicoPendingRecord,
        bundle: SmartAccountBundle | null,
      ): Promise<BatchPaymentResult> => {
        holdRecord(record, true);
        const calls = buildTransferCalls(params);
        if (fingerprintTransferCalls(calls) !== record.callFingerprint) {
          throw new PimlicoResponseUnknownError({
            userOpHash: record.userOpHash,
            callFingerprint: record.callFingerprint,
            reason: 'call-fingerprint-mismatch',
          });
        }
        if (!hasSendLedger(record)) {
          // 送信の控えが無い記録 (この欄を足す前の記録・MAv2 の facade で送った記録) は今までどおり receipt を待つだけ。
          // Pimlico の client が無い (Circle の経路) ときは、再び使えるようになるまで hash を保持する (今までどおり)。
          if (bundle) return waitForRetainedReceipt(bundle.pimlicoClient, record);
          throw new PimlicoResponseUnknownError({
            userOpHash: record.userOpHash,
            callFingerprint: record.callFingerprint,
            reason: 'pimlico-client-unavailable',
          });
        }
        const intent = await import('@/lib/smartAccount/pimlicoIntent');
        const sendClient = bundle && intent.asSignedSendClient(bundle.smartAccountClient);
        return intent.resolveOpenIntent(
          intentHost(bundle, bundle && sendClient ? senderOf(bundle, sendClient) : null),
          record,
          calls,
        );
      };

      if (!clients) {
        // 今の account の Smart Account が無い (委任を外した・変えた・初期化中) ときも、開いている intent の照合 (receipt と
        // EntryPoint の nonce を読むだけ・送らない) は行う (第 10 回レビュー A-1 の Codex 第 2 回 MUST 3)。照合しないと、期限を
        // 過ぎた記録を閉じられず、その範囲の gasless と通常決済が止まったままになる。送信の控えの無い記録・記録が無い・
        // storage が読めないときは今までどおり。
        const held =
          pendingRef.current?.storageKey === pimlicoStorageKey
            ? pendingRef.current.record
            : null;
        const read = held ? null : readPimlicoPending(pimlicoStorageKey);
        const open = held ?? (read?.kind === 'record' ? read.record : null);
        if (open && hasSendLedger(open)) return openIntent(open, null);
        throw new Error(
          'Smart Account がまだ初期化されていません。ウォレット接続とネットワーク選択を確認してください。',
        );
      }

      let retained: PimlicoPendingRecord | null = null;
      if (pendingRef.current?.storageKey === pimlicoStorageKey) {
        retained = pendingRef.current.record;
      } else {
        const read = readPimlicoPending(pimlicoStorageKey);
        if (read.kind === 'unavailable') {
          // fail-closed: 未解決 UserOp の有無を判定できない状態では新規送信しない。
          // 何の波及を断つか: latch を失った端末が broadcast 済 UserOp の上に 2 本目を
          // 重ねる二重支払いを断つ (lib/circlePending の requireStorage と同じ方針)。
          // 止めるのは gasless のみ — standard は localStorage に依存しないので、
          // この fail-closed を通常決済へ波及させない (呼出元 UI で分岐する)。
          setPendingStoreUnavailable(true);
          throw new PimlicoPendingStoreUnavailableError(String(read.error));
        }
        setPendingStoreUnavailable(false);
        retained = read.kind === 'record' ? read.record : null;
      }
      if (retained && clients.provider === 'circle') {
        // provider が切り替わっても、未解決の Pimlico UserOp から Circle の新規送信へ
        // 波及させない。Pimlico client が再び利用可能になるまで hash を保持する。照合 (読むだけ) は Pimlico の client が
        // 無くても行う (openIntent・MUST 3)。
        return openIntent(retained, null);
      }

      // provider で exhaustive 分岐 (計画 C6)。Circle は二重決済耐性 FSM
      // (executeCirclePayment) に委譲、Pimlico は従来の単発送信。
      if (clients.provider === 'circle') {
        return runCirclePayment({
          bundle: clients,
          params,
          customer,
          chainId,
          walletClient,
          publicClient,
          isAlive: () => mountedRef.current,
          setStoreUnavailable: setPendingStoreUnavailable,
        });
      }

      const { smartAccountClient, pimlicoClient } = clients;
      if (retained) return openIntent(retained, clients);

      // 新しい支払い。送信を分ける部品と intent の関所を読む (dynamic import)。ここで失敗しても nonce の採番・署名・保存・
      // 送信の前なので、今までどおりの error で終わる (応答不明にしない)。
      const intent = await import('@/lib/smartAccount/pimlicoIntent');

      // JPYC ガス無料化 (2026-06-05): JPYC sponsorship のガス代立替回収を全廃したため、
      // 旧「feeReceiver 集約額 > 0 必須」の濫用防御ガードは撤去 (OpenPay が JPYC gas を
      // 全額負担する設計に変更)。paymaster の濫用対策は Pimlico policy 制限と relayer/
      // paymaster 低残高監視 (#148) に委ねる。gasReimbursement は呼出側で常に 0。

      // gas ceiling は両 mode で適用。sponsorship では運営赤字回避、erc20 では
      // 顧客の USDC 出費上限の保護として機能する (どちらも UX 上の安全弁)。
      // ここは送信を始める前の fast の検査。UserOp に実際に入る standard は、準備の中の fee の見積もり
      // (lib/smartAccount の各 builder) が ceilingCheckedStandardFee で検査する (A-5)。
      if (chainId !== undefined) {
        const gasPrice = await pimlicoClient.getUserOperationGasPrice();
        assertGasCeiling(chainId, gasPrice.fast.maxFeePerGas);
      }

      const calls = buildTransferCalls(params);

      // 送信を「nonce を決める → 準備 → 署名 → 保存 → 送信」に分けられる client か (permissionless で作る
      // simple 7702・MetaMask)。MAv2 は aa-sdk を包んだ facade で sendUserOperation しか無いので null になり、
      // 下の「今までの送信」をそのまま使う (第 10 回レビュー A-1 の対象の外・lib/smartAccount/mav2.ts)。
      const sendClient = intent.asSignedSendClient(smartAccountClient);
      if (sendClient) {
        const sender = senderOf(clients, sendClient);
        return intent.startIntent(intentHost(clients, sender), sender, {
          base: {
            schemaVersion: PIMLICO_PENDING_SCHEMA_VERSION,
            provider: 'pimlico',
            chainId: chainId ?? deployment.chainId,
            customer: customer?.toLowerCase() ?? 'disconnected',
            tokenAddress: params.tokenAddress,
            params: serializeBatchPaymentParams(params),
          },
          calls,
          callFingerprint: fingerprintTransferCalls(calls),
        });
      }

      // MAv2 (aa-sdk の facade): 準備・署名・送信を分けられないので、今までの送信のまま。
      // 本番でここに届くのは JPYC の relay が OFF のときだけ (lib/smartAccount/mav2.ts の冒頭)。
      const userOpHash = await smartAccountClient.sendUserOperation({ calls });
      const now = Date.now();
      const pendingRecord: PimlicoPendingRecord = {
        schemaVersion: PIMLICO_PENDING_SCHEMA_VERSION,
        provider: 'pimlico',
        status: 'pending',
        chainId: chainId ?? deployment.chainId,
        customer: customer?.toLowerCase() ?? 'disconnected',
        tokenAddress: params.tokenAddress,
        callFingerprint: fingerprintTransferCalls(calls),
        userOpHash,
        params: serializeBatchPaymentParams(params),
        createdAt: now,
        updatedAt: now,
      };
      // sendUserOperation が hash を返した時点で、receipt RPC とは独立に復旧 handle を
      // 耐久化する。storage 障害は broadcast 済み決済を通常 error に変えず、同一タブの
      // memory latch を残して二重送金への波及を止める。
      pendingRef.current = {
        storageKey: pimlicoStorageKey,
        record: pendingRecord,
      };
      persistPimlicoPending(pimlicoStorageKey, pendingRecord);

      return waitForRetainedReceipt(pimlicoClient, pendingRecord);
    },
    onSuccess: (data, params) => {
      void logPaymentEvent(
        buildPaymentLogEvent(
          toCtx(params, customer, chainId, deployment, data),
          {
            result: data.success ? 'success' : 'reverted',
            userOpHash: data.userOpHash,
            txHash: data.txHash,
            blockNumber: data.blockNumber,
          },
        ),
      );
      // revert 時は ERC20 transfer も atomic に巻き戻り feeReceiver は何も
      // 受け取らない (回収 0)。collected には gas 立替回収分 (gasReimbursement) を渡す
      // — 利用手数料 (サービス料) は gas 補填ではないので突合対象外。success=false では
      // collected=0 (gas は消費済なので actualGasCost > 0 → under_collected を正しく検出)。
      // Circle (erc20・顧客が USDC で gas 負担) は sponsorship 収支の概念が無く、
      // かつ testnet では resolvePaymasterMode が sponsorship に倒れて誤検知するため除外。
      if (clients?.provider !== 'circle') {
        reconcileSponsorshipGas(
          deployment,
          chainId,
          data.success ? (params.gasReimbursement ?? 0n) : 0n,
          data.actualGasCost,
        );
      }
    },
    onError: (error, params) => {
      // CirclePendingError は broadcast 済 op を持つ「確認待ち」(失敗ではない)。
      // userOpHash と provider を監査に残し、未 retry でも submitted op を追跡可能にする。
      // circleSend を静的 import しないよう (bundle budget) instanceof でなく name で判定。
      const pending =
        error.name === 'CirclePendingError' ||
        error.name === 'PimlicoResponseUnknownError'
          ? (error as Error & { userOpHash?: Hex })
          : undefined;
      const ctx = toCtx(params, customer, chainId, deployment);
      if (clients?.provider === 'circle') ctx.provider = 'circle';
      void logPaymentEvent(
        buildPaymentLogEvent(ctx, {
          result: 'error',
          errorMessage: error.message,
          userOpHash: pending?.userOpHash,
        }),
      );
    },
    // 試み中の印を外す。react-query は、作った mutation が終わると (成功でも、mutationFn の throw = 入口の payment_cancelled を
    // 含む失敗でも・unmount の後でも) これを呼ぶ。外す所はここだけ。
    onSettled: () => {
      attemptInFlightRef.current = false;
    },
  });

  const retryReceipt = useCallback(() => {
    const retained =
      pendingRef.current?.storageKey === pimlicoStorageKey
        ? pendingRef.current.record
        : null;
    if (!retained || mutation.isPending) return;
    // 印を立てる前に、return・throw しうる処理を済ませる (立てた後に mutation を作らずに抜けると、onSettled が来ず、
    // 開き直すまで送れなくなる)。
    const params = deserializeBatchPaymentParams(retained.params);
    if (attemptInFlightRef.current) return;
    attemptInFlightRef.current = true;
    mutation.mutate(params);
  }, [mutation, pimlicoStorageKey]);

  // 画面 (フォーム) から最後に送った支払いの内容 (calls の fingerprint)。retryReceipt は保存した intent の params で
  // 送るので、ここには入れない (第 10 回レビュー A-1 の MUST 2: 成功の表示を確定した intent に結び付ける)。
  const [submittedFingerprint, setSubmittedFingerprint] = useState<Hex | null>(
    null,
  );
  const { mutate: rawMutate, mutateAsync: rawMutateAsync } = mutation;
  const mutate = useCallback<typeof rawMutate>(
    (params, options) => {
      // 試み中の 2 回目は何もしない。fingerprint を書く前に見る (無視した 2 回目が別の内容でも、1 回目の成功を
      // 「別の intent の確定」(settledOtherIntent) にしない)。印を立ててから rawMutate までは同期で隣り合わせ。
      if (attemptInFlightRef.current) return;
      setSubmittedFingerprint(attemptFingerprint(params));
      attemptInFlightRef.current = true;
      rawMutate(params, options);
    },
    [rawMutate],
  );
  const mutateAsync = useCallback<typeof rawMutateAsync>(
    (params, options) => {
      // 試み中の 2 回目は mutation を作らずに断る (hooks/useUsageFeePayment.ts と同じ)。断った押下に送金の結果は無いので、
      // resolve せず reject する。1 回目の mutation と fingerprint には触らない。呼ぶ所は今は無い。
      if (attemptInFlightRef.current) {
        return Promise.reject(new Error('payment_in_progress'));
      }
      setSubmittedFingerprint(attemptFingerprint(params));
      attemptInFlightRef.current = true;
      return rawMutateAsync(params, options);
    },
    [rawMutateAsync],
  );
  // 確定した支払い (data) が、画面から最後に送った支払いとは別の intent のものか (前に結果が分からなかった支払いを
  // 「同じ送信内容を再確認」で確定した・reload の後に確定した・別の account で送った後に戻った等)。true のとき、画面は
  // 自分の金額・明細で成功を出さない (出すと「20 USDC 成功」で実際は 10 USDC、がありうる)。
  const settledFingerprint = useMemo(
    () =>
      mutation.data && mutation.variables
        ? attemptFingerprint(mutation.variables)
        : null,
    [mutation.data, mutation.variables],
  );
  const settledOtherIntent =
    settledFingerprint !== null && settledFingerprint !== submittedFingerprint;
  // 別の intent の確定のときに、その intent 自体の受取先・金額 (保存した params = retryReceipt が渡した variables) を返す。
  // 履歴・支払い者の控えは、これだけで書き、今の画面の店・注文・明細と組み合わせない (第 10 回レビュー A-1 の Codex 第 2 回
  // MUST 2・判断はここ 1 か所)。記録の chain・token が今の画面の deployment と違うときは null (今の画面の chain・token の
  // 表示で書くと別の chain の支払いとして残る = 帰属を確かめられないので、書かない。画面には hash が出る)。
  const recoveredIntent =
    settledOtherIntent &&
    mutation.variables &&
    settledChainId === deployment.chainId &&
    isAddressEqual(mutation.variables.tokenAddress, deployment.address)
      ? mutation.variables
      : null;

  const activeUnknown =
    unknownPending?.storageKey === pimlicoStorageKey
      ? unknownPending.record
      : null;

  return {
    ...mutation,
    mutate,
    mutateAsync,
    // response-unknown を通常 failure として履歴/汎用 error UI へ流さない。フォームは
    // isUnknown を relayAmbiguous と同じ pending/unknown 表示へ束ねる。
    // storage 不能 (fail-closed) は isUnknown に混ぜない — broadcast 済 UserOp が在ると
    // 言い切れる状態ではなく、混ぜると通常決済まで封鎖してしまうため別 flag で返す。
    // 期限を過ぎた intent を照合で閉じた (PimlicoIntentClosedError) のは失敗ではないので出さない。
    error:
      activeUnknown ||
      pendingStoreUnavailable ||
      mutation.error instanceof PimlicoIntentClosedError
        ? null
        : mutation.error,
    isUnknown: activeUnknown !== null,
    settledOtherIntent,
    recoveredIntent,
    // gasless だけを止めるための専用 flag (呼出元は standard 経路を塞がない)。
    pendingStoreUnavailable,
    pendingUserOpHash: activeUnknown?.userOpHash,
    retryReceipt,
  };
}

// merchant (+split +fee) への ERC20 transfer calls を組む。両 provider で共有。
// 空 batch (何も transfer しない) は弾く (gas だけ払う UserOp / account error を防ぐ)。
function buildTransferCalls(
  params: BatchPaymentParams,
): Array<{ to: Address; data: Hex }> {
  const transfer = (to: Address, amount: bigint) => ({
    to: params.tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer' as const,
      args: [to, amount],
    }),
  });
  const calls: Array<{ to: Address; data: Hex }> = [];
  if (params.merchantAmount > 0n) {
    calls.push(transfer(params.merchant, params.merchantAmount));
  }
  for (const r of params.extraRecipients ?? []) {
    if (r.amount <= 0n) {
      throw new Error(
        `split 受取人 ${r.to} の配分額が 0 です (UI 側で防がれているはず)`,
      );
    }
    calls.push(transfer(r.to, r.amount));
  }
  // feeReceiver へは 利用手数料 (サービス料・0) + gas 立替回収 (JPYC sponsorship のみ) を
  // 1 件に合算して送る。erc20 / circle は gasReimbursement=0 のため transfer は載らない。
  const feeReceiverTotal = params.feeAmount + (params.gasReimbursement ?? 0n);
  if (feeReceiverTotal > 0n) {
    calls.push(transfer(params.feeReceiver, feeReceiverTotal));
  }
  if (calls.length === 0) {
    throw new Error('送金額が 0 です。金額を入力してください。');
  }
  return calls;
}

// Circle Paymaster (USDC ガスレス) 経路。二重決済耐性 FSM (executeCirclePayment) に
// 委譲する。permitAmount は useGasQuoteCircle (chunk5) が算定した確定値が params 経由で
// 渡る。gas ceiling (顧客 USDC 保護) は送信前に適用する。
async function runCirclePayment(args: {
  bundle: CircleSmartAccountBundle;
  params: BatchPaymentParams;
  customer: Address | undefined;
  chainId: number | undefined;
  walletClient: ConnectedWalletClient | undefined;
  publicClient: PublicClient | undefined;
  // この試みを始めた hook の instance がまだ画面にあるか (unmount の後は false のまま・第 10 回レビュー H-V)。
  isAlive: () => boolean;
  // hook の pendingStoreUnavailable の setter (Pimlico の経路の intentHost.setStoreUnavailable と同じもの)。
  setStoreUnavailable: (unavailable: boolean) => void;
}): Promise<BatchPaymentResult> {
  const { bundle, params, customer, chainId, walletClient, publicClient, isAlive } = args;
  if (!customer || !walletClient || !publicClient) {
    throw new Error(
      'ウォレットが接続されていません。接続とネットワークを確認してください。',
    );
  }
  const permitAmount = params.circlePermitAmount;
  if (permitAmount === undefined || permitAmount <= 0n) {
    throw new Error(
      'USDC ガスレス決済のガス上限 (permitAmount) が未算定です。再読み込みして再試行してください。',
    );
  }

  // Circle 実装群を dynamic import (baseline bundle から除外・circle 決済実行時のみロード)。
  // circlePending は circleSend (動的) が依存する軽量モジュールなので同じ群に含めて baseline から外す。
  const [
    { getCircleUserOpGasPrice, entryPoint08Address },
    { executeCirclePayment },
    { verifyCircleReceiptOnChain },
    { computeCallHash, stableAttemptId, clearStableAttemptId, setStableAttemptId },
  ] = await Promise.all([
    import('@/lib/smartAccount/circleAccount'),
    import('@/lib/smartAccount/circleSend'),
    import('@/lib/circleReceiptVerifier'),
    import('@/lib/circlePending'),
  ]);

  // gas ceiling: 顧客の USDC 出費上限の UX 保護 (混雑時に異常 gas を弾く)。
  const gasPrice = await getCircleUserOpGasPrice(bundle);
  assertGasCeiling(chainId ?? bundle.chainId, gasPrice.maxFeePerGas);

  const calls = buildTransferCalls(params);

  // 失効した試みは、ここから先 (attemptId の対応の作成・古い記録の掃除と scan の abandon・記録の予約) を始めない。mutationFn の
  // 先頭の確認の後に、上の await (動的 import・ガス価格) が 2 つある。何の波及を断つか: その間に画面を離れた試みが、誰も署名
  // しない記録 (awaiting_signature) と対応を残すこと (別のタブの同じ内容の支払いが、その記録を「別の試みが署名中」とみなして
  // 最大 3 分止まる)・古い記録の abandon を、画面の無い試みの判断で行うこと。
  if (!isAlive()) throw new Error('payment_cancelled');

  // 冪等試行 ID:
  //   - 明示供給 (params.paymentAttemptId) があればそれを素通しし、マッピングは一切触らない。
  //   - 無ければ callHash 由来の安定マッピング (sessionStorage) で同一タブの再クリック/reload に
  //     同じ attemptId を割り当て、executeCirclePayment 内の crash-resume 分岐を機能させる。
  //     **対応を保存できなかった押下は、新しい支払いを始めない** (stableAttemptId の saved が false = sessionStorage を
  //     読めない・書けない・書いても残らない端末。第 10 回レビューの後追い r10-ss)。何の波及を断つか: 保存していない attemptId で
  //     新しい支払いを送ると、その支払いが確認待ちで終わった後の押下が別の attemptId (別の key) になり、裏で確定した前の支払い
  //     (90 秒より前の confirmed) の後に 2 本目の署名を求める。
  //     止めるのは executeCirclePayment の中 = 新しい記録を予約する直前 (mappingSaved: false を渡す・circleSend.ts の冒頭の
  //     「対応を保存できていない押下」)。**ここ (入口) では止めない**: 既にある支払いの復旧・結果の受け取り (scan) は、対応を
  //     保存できなくても今までどおり通す (入口で止めると、対応を保存した後に sessionStorage を読めなくなった端末で、送った
  //     支払いの結果を受け取れなくなる)。saved が false の attemptId は、保存していない、押すたびに変わる id で、scan に使う。
  //     止まった押下 (下の catch) は、localStorage を読めない端末と同じ flag (pendingStoreUnavailable) を立てる: 画面には
  //     「この端末では記録を保存できません」の欄が出る (gasless だけを止める・hook の error は null・3 フォームは flag で
  //     送信を閉じる)。既にある対応を読めた押下 (saved: true・確認待ちの続き) は、今までどおり。
  // sender は executeCirclePayment が computeIdempotencyKey に使う owner (=customer) と同一値、
  // chainId は executeCirclePayment が使う bundle.chainId と同一値にする (key 不一致を避ける)。
  const usesStableMapping = params.paymentAttemptId === undefined;
  const attemptArgs = { chainId: bundle.chainId, sender: customer, callHash: computeCallHash(calls) };
  const { attemptId, saved } =
    params.paymentAttemptId === undefined
      ? stableAttemptId(attemptArgs)
      : { attemptId: params.paymentAttemptId, saved: true };
  // この試みが、マッピングの指す先だと知っている attemptId。入口で読んだ / 作った id で、この試みが付け替えたら
  // (下の adoptAttempt)、付け替えた先の id になる。マッピングを破棄するのは、マッピングがいまもこの値を指しているときだけ
  // (下の 2 か所の clearStableAttemptId)。何の波及を断つか: マッピングは同じタブの別の試み (同じ sessionStorage を使う別の
  // 画面) と共有する。別の試みが、まだ画面に出ていない支払いの記録へ付け替えた後に、この試みが自分の古い attemptId のつもりで
  // 消すと、次の押下が新しい key になり、その支払いが確定して 90 秒を過ぎていれば 2 本目を払う (穴 B の Codex の指摘)。
  let mappedAttemptId = attemptId;

  let result: Awaited<ReturnType<typeof executeCirclePayment>>;
  try {
    result = await executeCirclePayment({
      bundle,
      publicClient,
      walletClient,
      owner: customer,
      calls,
      permitAmount,
      paymentAttemptId: attemptId,
      isAlive,
      mappingSaved: saved,
      // 対応の付け替え (第 10 回レビュー 穴 B・条件は circleSend.ts の冒頭の「対応の付け替え」)。scan が別の key の記録
      // (別のタブ・閉じたタブの支払い) の結果を受け取りに行く押下は、自分の attemptId の記録を作らない。そのまま画面を離れる・
      // 確認待ちで終わると、対応は記録の無い attemptId を指し、次の押下が、後から確定したその支払いを「正規のリピート」と
      // みなして 2 本目を払う。なので、受け取りに行く直前に、対応をその記録の attemptId に付け替えさせる。
      // 明示の paymentAttemptId のときは渡さない (上のとおり、マッピングは一切触らない)。
      // 書けたときだけ、この試みの「マッピングの指す先」も付け替えた先にする (書けなければマッピングは前の値のまま)。
      // 書けたかを返す (第 10 回レビュー PR-39c): 書けなかった付け替えの確認待ちを、circleSend が「このタブでもう一度押すと、
      // まず同じ支払いの結果を確かめ直します」の場面 (a) にしないため (対応が前の値のままなので、次の押下はその記録を resume しない)。
      // **最初の対応を保存できていない押下 (saved が false) では、書けても false を返す** (第 10 回レビューの後追い r10-ss)。
      // sessionStorage の getItem だけが throw し setItem は通る端末では、付け替えは「書けた」になるが、次の押下はその対応を
      // 読めない (resume にならず、また scan から入る)。(a) の約束は言えないので、circleSend に (e) を出させる。
      // 書き込み自体は今までどおり試す (後で読めるようになった端末では、対応がその記録を指している方がよい)。この試みの
      // 「マッピングの指す先」を替えるのも、今までどおり「書けたとき」。
      adoptAttempt: usesStableMapping
        ? (adopted) => {
            const written = setStableAttemptId(attemptArgs, adopted);
            if (written) mappedAttemptId = adopted;
            return written && saved;
          }
        : undefined,
    });
  } catch (error) {
    // CirclePendingError (broadcast 済・確認待ち) はマッピングを保持し、再クリックで自 attempt を
    // resume させる (scan が別の key の記録を復旧していた押下では、マッピングは上の adoptAttempt でその記録の attemptId に
    // 付け替わっているので、再クリックはその記録を resume する)。それ以外の確定的エラー (revert/拒否/abandon 済) はマッピングを破棄して、
    // resumed 分岐の「この支払いの試みは既に終了しています」に正規の再試行がぶつからないようにする。
    // 失効した試みは破棄しない (下の成功のときと同じ理由)。破棄するのは、マッピングがいまもこの試みの知っている attemptId を
    // 指しているときだけ (上の mappedAttemptId。別の試みが付け替えた後のマッピングは消さない)。
    // storage の失敗 (lib/circlePending の PendingStoreUnavailableError・PendingStoreWriteError) も破棄しない: この押下は
    // 自分の記録の状態を確かめられなかった (分からない)。何の波及を断つか: storage が一時的に読めない・書けない押下 (入口の
    // scan・resume の読み取り・予約の書き込みなど、送った後の境界の外) が対応を消し、次の押下が新しい key になって、裏で確定して
    // いた前の支払い (90 秒より前の confirmed) の後に 2 本目が開くこと (第 10 回レビュー PR-39a の Codex P2)。残しても、次の押下は
    // 同じ記録を resume するだけで、記録が終わっていれば「既に終了」で破棄される。error の文はそのまま出す。
    // circleSend・circlePending は静的 import しない (bundle budget・上の動的 import) ので、CirclePendingError と同じく name で判定する。
    const name = (error as Error).name;
    // 対応を保存できていない押下が、新しい記録を予約する直前で止まった (上の「冪等試行 ID」・circleSend.ts の冒頭の「対応を
    // 保存できていない押下」)。新しい記録・署名・送信は何も始まっていない。「この端末では記録を保存できません」の欄の flag を
    // 立て、localStorage を読めない端末と同じ error で終える (hook の error は null になる)。対応は破棄しない: この押下の
    // attemptId は保存できていない id で、対応に残っている値 (読み戻しの不一致で残った値など) は、この試みのものと言えない。
    if (name === 'CircleAttemptMappingUnavailableError') {
      args.setStoreUnavailable(true);
      throw new PimlicoPendingStoreUnavailableError('attempt-mapping-unavailable');
    }
    if (
      usesStableMapping &&
      isAlive() &&
      name !== 'CirclePendingError' &&
      name !== 'PendingStoreUnavailableError' &&
      name !== 'PendingStoreWriteError'
    ) {
      clearStableAttemptId(attemptArgs, mappedAttemptId);
    }
    throw error;
  }

  // 監査: receipt から net USDC を再計算 (client-reported)。pending record の
  // userOpHash/sender/paymaster を expected binding に使う。verify は best-effort で、
  // 失敗しても確定済の決済を巻き込まない (net は undefined のまま)。サーバ側の
  // 再検証 writer は無く、ログには client 申告としてのみ記録する。
  let circlePaymasterNetUsdc: string | undefined;
  let circleVerification: CircleVerificationStatus | undefined;
  try {
    const v = await verifyCircleReceiptOnChain({
      publicClient,
      txHash: result.txHash,
      expected: {
        userOpHash: result.userOpHash,
        sender: customer,
        paymaster: bundle.paymasterAddress,
        token: bundle.deployment.address,
        entryPoint: entryPoint08Address,
      },
    });
    if (v.status === 'verified') {
      circlePaymasterNetUsdc = v.netUsdc.toString();
      circleVerification = 'client-reported';
    } else {
      circleVerification = 'unreconciled';
      // 構造化 kind で分類 (reason 文字列の regex マッチに依存しない)。binding 不一致
      // (paymaster/sender) は permit spender = 信頼境界の破れ (想定外/悪意 paymaster が
      // 顧客 USDC を pull した RED FLAG) なので error、それ以外 (revert/no-charge/absent) は warn。
      const bindingViolation =
        v.kind === 'binding-paymaster' || v.kind === 'binding-sender';
      const entry = {
        kind: v.kind,
        reason: v.reason,
        userOpHash: result.userOpHash,
        sender: customer,
        paymaster: bundle.paymasterAddress,
      };
      if (bindingViolation) logger.error('circle.receipt.binding-violation', entry);
      else logger.warn('circle.receipt.unreconciled', entry);
    }
  } catch (error) {
    // receipt 取得失敗 (RPC flake) = binding 違反ではない。別 key で記録。
    circleVerification = 'unreconciled';
    logger.warn('circle.receipt.verify-failed', {
      userOpHash: result.userOpHash,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 成功確定 → マッピングを破棄 (次の同額購入は新 attempt。直近 double-click の dedup は
  // scan の CONFIRMED_DEDUP_WINDOW_MS が引き続き担う)。
  // 失効した試みは破棄しない (error でも成功でも)。何の波及を断つか: マッピングは「chain・sender・内容ごとに 1 つ」で、同じタブで
  // 開き直した画面も同じものを使う。画面の無い試みが消すと、開き直した画面の次の押下が新しい key になり、この試みが送った op の
  // 記録 (confirmed・90 秒を過ぎたもの) を「正規のリピート」とみなして 2 本目を払う (この支払いの成功は、もう無い画面にしか
  // 出ていない)。残しておけば、次の押下は同じ key を resume して既払いの結果を受け取り、そこで破棄される。
  // これは、この試みが自分で送った支払いでも、scan で別の key の記録 (別のタブ・閉じたタブの支払い) の結果を受け取った場合でも
  // 成り立つ: 後者は、受け取りに行く直前に対応をその記録の attemptId に付け替えてある (上の adoptAttempt)。付け替えない
  // 場合 (最後に bundler へ渡してから 30 分より後の記録の復旧) だけは、対応は記録の無い attemptId のまま残り、次の押下は
  // scan からやり直す (circleSend.ts の冒頭の「対応の付け替え」の残る限界)。付け替えた試みは、付け替えた先の id を
  // mappedAttemptId に持つので、画面のある試みが結果を受け取れば、付け替えた後の対応もここで消える。
  // 画面のある試みでも、マッピングがこの試みの知らない値に替わっていたら破棄しない (上の mappedAttemptId): 同じタブの別の
  // 試みが付け替えた・作り直したマッピングで、その試みの支払いの続きに要る。
  // 監査の後ろで見るのは、確定の後も上の監査 (receipt の RPC) の await の間は成功がまだ画面に出ていないから。その間に画面を
  // 離れた試みも、成功を画面に出せないまま終わるので、対応を残す (この確認から return まで await は無い)。
  // 代償: 失効した試みが払い終えた後、同じタブで同じ内容を意図してもう一度払うと、最初の 1 回は前の支払いの結果が出る
  // (もう一度押せば新しい支払い。ただし confirmed から 90 秒以内は、押すたびに前の結果を返す = 今までと同じ動き)。払えたことを
  // 知らずにもう一度払う害の方が大きいので dedup の側に倒す (circleSend.ts の confirmed の dedup と同じ方針)。
  if (usesStableMapping && isAlive()) clearStableAttemptId(attemptArgs, mappedAttemptId);

  return {
    ...result,
    provider: 'circle',
    circlePaymasterAddress: bundle.paymasterAddress,
    circlePaymasterNetUsdc,
    circleVerification,
  };
}

// sponsorship 収支の実観測 (案A の units 次元残存リスクの監視)。
// 運営は native gas を Pimlico sponsorship で立て替え、顧客から JPYC (feeAmount) で
// 回収する。実 gas (actualGasCost native × native/JPYC rate) が回収額を上回ると
// その tx は運営赤字 = collect-at-ceiling の units 次元で under-collect が実発生した
// シグナル。logger.warn は Sentry に送られ、運用 (overhead/rate/ceiling 調整) の
// トリガになる。erc20 paymaster mode は顧客が実 gas を直接負担するので対象外。
function reconcileSponsorshipGas(
  deployment: TokenDeployment,
  chainId: number | undefined,
  collectedJpyc: bigint,
  actualGasCostNative: bigint,
): void {
  if (resolvePaymasterMode(deployment) !== 'sponsorship') return;
  const cid = chainId ?? deployment.chainId;
  const rate = resolveNativeJpycRate(cid);
  const actualCostJpyc = actualGasCostNative * rate;
  const base = {
    chainId: cid,
    collectedJpyc: collectedJpyc.toString(),
    actualGasCostNative: actualGasCostNative.toString(),
    actualCostJpyc: actualCostJpyc.toString(),
    rate: rate.toString(),
  };
  if (actualCostJpyc > collectedJpyc) {
    logger.warn('payment.sponsorship.under_collected', {
      ...base,
      shortfallJpyc: (actualCostJpyc - collectedJpyc).toString(),
    });
  } else {
    logger.info('payment.sponsorship.gas_reconciled', {
      ...base,
      surplusJpyc: (collectedJpyc - actualCostJpyc).toString(),
    });
  }
}

function toCtx(
  params: BatchPaymentParams,
  customer: Address | undefined,
  chainId: number | undefined,
  deployment: TokenDeployment,
  // 成功結果 (provider/Circle 監査フィールド)。error 経路では undefined。
  result?: BatchPaymentResult,
): PaymentLogContext {
  return {
    flow: 'batch',
    chainId: chainId ?? deployment.chainId,
    tokenAddress: params.tokenAddress,
    merchant: params.merchant,
    merchantAmount: params.merchantAmount,
    customer,
    feeReceiver: params.feeReceiver,
    feeAmount: params.feeAmount,
    saleAmount: params.saleAmount,
    networkFeeEquivalent: params.networkFeeEquivalent,
    provider: result?.provider,
    circlePaymasterAddress: result?.circlePaymasterAddress,
    circlePaymasterNetUsdc: result?.circlePaymasterNetUsdc,
    circleVerification: result?.circleVerification,
  };
}
