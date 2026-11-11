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
import {
  asSignedSendClient,
  broadcastPimlicoUserOp,
  findUserOperationReceipt,
  isUserOpNonceConsumed,
  joinUserOpNonce,
  prepareAndSignPimlicoUserOp,
  reserveUserOpNonce,
  splitUserOpNonce,
  toUserOperationRejection,
  type PimlicoSignedUserOp,
  type PreparedPimlicoUserOp,
  type SignedSendClient,
} from '@/lib/smartAccount/pimlicoSend';
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
// 送信の控えのある record は黙って消さない (第 10 回レビュー A-1 の c4): 保存の期限は署名を取り消さず、
// 実行されなかった証拠にもならない。期限を過ぎた記録も開いたまま復元し、次に確かめるとき、候補の receipt と
// EntryPoint の nonce を照合して、どちらも無いときだけ閉じる (useBatchPayment の mutationFn)。
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

// 送信の前に保存する「送信の控え」(第 10 回レビュー A-1)。任意の欄で、これが無い記録 (この欄を足す前に
// 書かれた記録・MAv2 の facade で送った記録) は今までどおり hash の receipt の照会だけで扱う。
type PimlicoSendLedger = {
  entryPoint: Address;
  sender: Address;
  // この支払いの UserOperation の nonce (10 進)。EntryPoint は同じ (sender, key, seq) の op を最大 1 本しか
  // 実行しないので、作り直しの op を必ずこの nonce で作るかぎり、二重には実行されない (安全の根拠)。
  // key だけ固定して seq を読み直すのは不可 (元の op が取り込まれた後の seq+1 で通ってしまう)。
  nonceKey: string;
  nonceSeq: string;
  // 署名済みの op (RPC の形)。応答を失ったときに 1 字も変えずに送り直す。この op で動くのは同じ送金 1 回だけ。
  signedUserOp: PimlicoSignedUserOp;
  // 同じ支払いを同じ nonce で作り直す前の op の hash。作り直した後に元の op が取り込まれたとき、
  // その receipt を引くために残す (取り込まれるのはどれか 1 本だけ)。
  priorUserOpHashes?: Hex[];
};

type PimlicoPendingRecord = {
  schemaVersion: typeof PIMLICO_PENDING_SCHEMA_VERSION;
  provider: 'pimlico';
  // pending / unknown = 結果が分からない op がある (reload の後はどちらも「応答不明」として復元する)。
  status: 'pending' | 'unknown';
  chainId: number;
  customer: string;
  tokenAddress: Address;
  callFingerprint: Hex;
  userOpHash: Hex;
  params: StoredBatchPaymentParams;
  createdAt: number;
  updatedAt: number;
  send?: PimlicoSendLedger;
};

type LedgerPimlicoPendingRecord = PimlicoPendingRecord & {
  send: PimlicoSendLedger;
};

function hasSendLedger(
  record: PimlicoPendingRecord,
): record is LedgerPimlicoPendingRecord {
  return record.send !== undefined;
}

function ledgerNonce(send: PimlicoSendLedger): bigint {
  return joinUserOpNonce(BigInt(send.nonceKey), BigInt(send.nonceSeq));
}

// この支払い (同じ nonce) で bundler に渡したことのある op の hash。新しいものから。
function ledgerUserOpHashes(record: LedgerPimlicoPendingRecord): Hex[] {
  return [
    record.userOpHash,
    ...[...(record.send.priorUserOpHashes ?? [])].reverse(),
  ];
}

// 保存から復元した記録の中の関係を確かめる: 記録の EntryPoint と sender が今の account のもので、署名済みの op の
// sender と nonce が記録の値と同じ。合わないとき (account の種類・委任先・接続先が変わった・記録の中が食い違う) は
// 「同じ nonce の op は最大 1 本」を今の client の上で使えないので、送り直し・作り直しをしない (receipt の照会だけ・
// 開いたまま)。これは復元の正しさのための確認で、同じ origin の任意の script (storage を書き換えられる) への防御ではない。
function ledgerMatchesAccount(
  send: PimlicoSendLedger,
  client: SignedSendClient,
): boolean {
  const { sender, nonce } = send.signedUserOp;
  return (
    isAddressEqual(client.account.entryPoint.address, send.entryPoint) &&
    isAddressEqual(client.account.address, send.sender) &&
    typeof sender === 'string' &&
    isAddress(sender, { strict: false }) &&
    isAddressEqual(sender, send.sender) &&
    typeof nonce === 'string' &&
    isHex(nonce, { strict: true }) &&
    BigInt(nonce) === ledgerNonce(send)
  );
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

// 保存の結果 (送信の前の保存 (第 10 回レビュー A-1) は 'stored' のときだけ送る):
//   stored     = 書けて、読み戻しても同じだった。
//   not-stored = 書き込み (setItem) が投げた。storage は書く前のまま (Web Storage の setItem は、書けないときは
//                何も変えずに投げる)。
//   uncertain  = 書き込みは返ったが、読み戻しが投げた・違った。書いた記録が storage に残っているかもしれない。
// 送信の後の更新 (status の書き換え等) は今までどおり戻り値を見ない。
type PimlicoPersistResult = 'stored' | 'not-stored' | 'uncertain';

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

function clearPimlicoPending(storageKey: string, userOpHash: Hex): void {
  if (typeof window === 'undefined') return;
  try {
    const current = readPimlicoPending(storageKey);
    if (current.kind === 'record' && current.record.userOpHash === userOpHash) {
      window.localStorage.removeItem(storageKey);
    }
  } catch (error) {
    // confirmed/reverted の本体結果へ localStorage housekeeping 障害を波及させない。
    // record が残った場合は安全側の unknown latch として次回 receipt 再照会に収束する。
    logger.warn('pimlico.pending.clear-failed', {
      storageKey,
      userOpHash,
      error,
    });
  }
}

export function useBatchPayment(
  deployment: TokenDeployment,
  enabled: boolean = true,
  // Circle 経路を抑止して Pimlico erc20 に固定する (TipForm 用)。useSmartAccount に伝播
  // させないと、決済実行に使う内部 client が Circle に routing され circlePermitAmount 不在で
  // 送信時に throw する (呼出元が表示用に disableCircle を立てても無効になる)。
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

  const mutation = useMutation<BatchPaymentResult, Error, BatchPaymentParams>({
    mutationFn: async (params) => {
      if (!clients) {
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
        // 波及させない。Pimlico client が再び利用可能になるまで hash を保持する。
        const latched = { storageKey: pimlicoStorageKey, record: retained };
        pendingRef.current = latched;
        setUnknownPending(latched);
        throw new PimlicoResponseUnknownError({
          userOpHash: retained.userOpHash,
          callFingerprint: retained.callFingerprint,
          reason: 'pimlico-client-unavailable',
        });
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
        });
      }

      const { smartAccountClient, pimlicoClient } = clients;
      // 送信を「nonce を決める → 準備 → 署名 → 保存 → 送信」に分けられる client か (permissionless で作る
      // simple 7702・MetaMask)。MAv2 は aa-sdk を包んだ facade で sendUserOperation しか無いので null になり、
      // 下の「今までの送信」をそのまま使う (第 10 回レビュー A-1 の対象の外・lib/smartAccount/mav2.ts)。
      const signedSend = asSignedSendClient(smartAccountClient);

      type PimlicoReceipt = Awaited<
        ReturnType<typeof pimlicoClient.waitForUserOperationReceipt>
      >;

      // receipt が取れた op で記録を閉じる。userOpHash は receipt が見つかった op の hash
      // (同じ nonce で作り直す前の op が取り込まれたときは、記録の今の hash と違う)。
      const settleRetained = (
        record: PimlicoPendingRecord,
        userOpHash: Hex,
        receipt: PimlicoReceipt,
      ): BatchPaymentResult => {
        // success / reverted の receipt 判定は従来どおり。どちらも on-chain 終端なので
        // unknown latch を解除し、次回の正規決済だけを許可する。
        clearPimlicoPending(pimlicoStorageKey, record.userOpHash);
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
        record: PimlicoPendingRecord,
      ): Promise<BatchPaymentResult> => {
        let receipt: PimlicoReceipt;
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
          persistPimlicoPending(pimlicoStorageKey, unknownRecord);
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

      // ---- intent (署名済みの UserOperation を保存した支払い) の扱い (第 10 回レビュー A-1) ----------
      // 不変条件: 署名済みの op を保存した時点から、その intent は「開いている」。開いている intent が記録の key の範囲
      // (chain・customer・token) にある間は、その範囲で別の nonce の op・別の内容の支払いを作らない (画面は isUnknown で
      // /pay と /checkout の通常決済も止める・lib/paymentFlowGuards)。作る op は必ず記録の nonce を使うので、送り直しても
      // 作り直しても EntryPoint は同じ nonce の op を最大 1 本しか実行しない。intent を閉じるのは次の 3 つだけ:
      //   c1 候補の hash のどれかに receipt がある → 成功 / revert で確定 (settleRetained)
      //   c2 **最初の送信** を bundler が検証で拒否した (HTTP 2xx + allowlist の code・lib/smartAccount/pimlicoSend.ts)
      //      → 記録を消したと確かめてから、今までどおりの error
      //   c4 保存から 7 日を過ぎ、候補のどれにも receipt が無く、EntryPoint の nonce も未使用 → 記録を消したと確かめてから
      // それ以外 (応答不明・送り直しや作り直しの拒否 (c3)・nonce が進んだのに receipt が無い (c5)) は開いたまま。

      // memory の記録を差し替える。応答不明として画面に出ている記録なら、画面の hash も合わせる。
      const holdRecord = (record: PimlicoPendingRecord, latched: boolean) => {
        const held = { storageKey: pimlicoStorageKey, record };
        pendingRef.current = held;
        if (latched) setUnknownPending(held);
      };

      // 結果が分からないまま記録を保持し、PimlicoResponseUnknownError で終える
      // (waitForRetainedReceipt の catch と同じ扱い。log の key は場面ごとに分ける)。
      const holdAsUnknown: (
        record: PimlicoPendingRecord,
        logKey: string,
        error: unknown,
      ) => never = (record, logKey, error) => {
        const unknownRecord: PimlicoPendingRecord = {
          ...record,
          status: 'unknown',
          updatedAt: Date.now(),
        };
        holdRecord(unknownRecord, true);
        persistPimlicoPending(pimlicoStorageKey, unknownRecord);
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(logKey, {
          userOpHash: record.userOpHash,
          callFingerprint: record.callFingerprint,
          error: reason,
        });
        throw new PimlicoResponseUnknownError({
          userOpHash: record.userOpHash,
          callFingerprint: record.callFingerprint,
          reason,
        });
      };

      type LedgerProbe =
        // この intent の op (今の op か、作り直す前の op) が取り込まれていた。
        | { kind: 'included'; userOpHash: Hex; receipt: PimlicoReceipt }
        // 候補の hash のどれにも receipt が無いが、記録の nonce はもう使われた (同じ nonce の op はもう実行されない)。
        // 自分の op が実行されたとも、されなかったとも言い切れない (c5): 計算した hash と bundler の hash が違って応答を
        // 失った・MetaMask の key 0 を別の op が使った。成功とも不成立ともせず、開いたまま receipt を待つ。
        | { kind: 'consumed' }
        // 取り込まれておらず、nonce も使われていない。同じ nonce の op を送ってよい。
        | { kind: 'open'; client: SignedSendClient }
        // nonce を確かめる・同じ nonce で送る手段が今の client に無い (MAv2 の facade・記録が今の account と合わない)。
        | { kind: 'unverifiable' };

      // 読むだけ: hash で receipt → 無ければ EntryPoint の getNonce(sender, key)。
      const probeLedger = async (
        record: LedgerPimlicoPendingRecord,
      ): Promise<LedgerProbe> => {
        const found = await findUserOperationReceipt<PimlicoReceipt>(
          pimlicoClient,
          ledgerUserOpHashes(record),
        );
        if (found) return { kind: 'included', ...found };
        if (
          !signedSend ||
          // 同じ nonce が「最大 1 本」を保証するのは同じ EntryPoint・同じ sender の上だけ。記録が今の account と
          // 合わないときは、送り直し・作り直しで二重払いを断てないので送らない (ledgerMatchesAccount)。
          !ledgerMatchesAccount(record.send, signedSend)
        ) {
          return { kind: 'unverifiable' };
        }
        const consumed = await isUserOpNonceConsumed({
          client: signedSend,
          entryPoint: record.send.entryPoint,
          sender: record.send.sender,
          nonce: ledgerNonce(record.send),
        });
        return consumed
          ? { kind: 'consumed' }
          : { kind: 'open', client: signedSend };
      };

      // 記録にある署名済みの op を送り、結果ごとに扱う (raw の eth_sendUserOperation・再送なし)。
      //   受理 (hash が返る)・「もう持っている」 → receipt を待つ
      //   届いたか分からない (timeout・通信断・HTTP の失敗・allowlist に無い code・判別できない) → 応答不明として保持
      //   bundler が検証で拒否した (HTTP 2xx + allowlist の code) → onRejected (場面ごとに違う)
      const broadcastRecorded = async (args: {
        client: SignedSendClient;
        record: LedgerPimlicoPendingRecord;
        latched: boolean;
        onRejected: (error: unknown) => Promise<BatchPaymentResult>;
      }): Promise<BatchPaymentResult> => {
        let record = args.record;
        const outcome = await broadcastPimlicoUserOp({
          client: args.client,
          signedUserOp: record.send.signedUserOp,
          entryPoint: record.send.entryPoint,
        });
        if (outcome.kind === 'validation-rejected') return args.onRejected(outcome.error);
        if (outcome.kind === 'unknown') {
          // bundler が受理した後に応答だけ失われた可能性がある。通常の error にすると、成立した op の上に
          // 再試行・通常決済が開いて二重払いになる (A-1)。保存済みの記録を応答不明としてラッチする。
          holdAsUnknown(record, 'pimlico.send.response-unknown', outcome.error);
        }
        // already-known: bundler がこの op を持っている。受理と同じく receipt を待つ。
        if (outcome.kind === 'accepted' && outcome.userOpHash !== record.userOpHash) {
          // 計算した hash は receipt を引く手がかりで、安全の根拠ではない (根拠は nonce)。
          // bundler の返した hash を正として記録を直す。
          logger.warn('pimlico.send.hash-mismatch', {
            computed: record.userOpHash,
            returned: outcome.userOpHash,
          });
          record = { ...record, userOpHash: outcome.userOpHash, updatedAt: Date.now() };
          holdRecord(record, args.latched);
          persistPimlicoPending(pimlicoStorageKey, record);
        }
        return waitForRetainedReceipt(record);
      };

      // 準備 → 署名 → **保存** → 送信。nonce は呼び出し側が決めた値をそのまま使う。
      const buildAndSend = async (args: {
        client: SignedSendClient;
        calls: ReturnType<typeof buildTransferCalls>;
        callFingerprint: Hex;
        nonce: bigint;
        // 開いている intent を同じ nonce で作り直すときの元の記録 (応答不明として画面に出ている)。新しい支払いでは無し。
        previous?: LedgerPimlicoPendingRecord;
      }): Promise<BatchPaymentResult> => {
        const { client, calls, callFingerprint, nonce, previous } = args;
        const latched = previous !== undefined;
        let built: PreparedPimlicoUserOp;
        try {
          built = await prepareAndSignPimlicoUserOp({ client, calls, nonce });
        } catch (error) {
          // 応答不明の記録の作り直しで準備・署名が失敗した (ウォレットで断った等)。何も送っていないので
          // 元の記録のまま応答不明を保つ (通常の error にすると画面が新しい支払いを開ける)。
          if (previous) {
            holdAsUnknown(previous, 'pimlico.rebuild.prepare-failed', error);
          }
          throw error;
        }
        const now = Date.now();
        const { key, seq } = splitUserOpNonce(nonce);
        // 候補の hash は intent に結び付けたまま残す (同じ nonce の候補のうち、取り込まれるのはどれか 1 本)。
        const priorUserOpHashes = previous
          ? [...(previous.send.priorUserOpHashes ?? []), previous.userOpHash]
          : [];
        const record: LedgerPimlicoPendingRecord = {
          schemaVersion: PIMLICO_PENDING_SCHEMA_VERSION,
          provider: 'pimlico',
          status: 'pending',
          chainId: chainId ?? deployment.chainId,
          customer: customer?.toLowerCase() ?? 'disconnected',
          // 作り直しは intent の内容 (保存した params) のまま。
          tokenAddress: previous?.tokenAddress ?? params.tokenAddress,
          callFingerprint,
          userOpHash: built.userOpHash,
          params: previous?.params ?? serializeBatchPaymentParams(params),
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          send: {
            entryPoint: built.entryPoint,
            sender: built.sender,
            nonceKey: key.toString(),
            nonceSeq: seq.toString(),
            signedUserOp: built.signedUserOp,
            ...(priorUserOpHashes.length > 0 ? { priorUserOpHashes } : {}),
          },
        };
        // 送信の前に、hash・署名済みの op・nonce を保存する。保存を確かめられなければ送らない:
        // 保存なしで送ると、応答を失ったときに「同じ nonce」を失い、再試行が別の nonce の op になる (二重払い)。
        // 止めるのは gasless だけ (読めないときの pendingStoreUnavailable と同じ側。通常決済は開けたまま)。
        // 署名済みの op はここで捨てる (どこにも送っていない)。
        const stored = persistPimlicoPending(pimlicoStorageKey, record);
        if (stored !== 'stored') {
          // 書けたかどうか分からない ('uncertain') ときは、送っていない op の記録を storage に残したまま「保存できません」
          // (= 通常決済は開く) にしない。新しい支払いは書いたかもしれない記録を消し、作り直しは元の記録 (開いている
          // intent) に書き戻して、そうなったと確かめる。
          const restored =
            stored === 'not-stored' ||
            (previous
              ? persistPimlicoPending(pimlicoStorageKey, previous) === 'stored'
              : discardPimlicoPending(pimlicoStorageKey));
          if (!restored) {
            // 署名済みの op が storage に残っているかもしれない (reload の後に「同じ送信内容を再確認」で送られうる)。
            // 送っていなくても intent を開いたまま (応答不明) にして、通常決済・別の支払いを開けない。
            holdAsUnknown(
              record,
              'pimlico.pending.persist-unverified',
              new Error(`persist-${stored}`),
            );
          }
          setPendingStoreUnavailable(true);
          throw new PimlicoPendingStoreUnavailableError('persist-failed');
        }
        holdRecord(record, latched);
        return broadcastRecorded({
          client,
          record,
          latched,
          onRejected: async (error) => {
            if (previous) {
              // c3: 作り直しの op を bundler が断った。前の候補が mempool に残っていることがある (Replacement
              // underpriced 等) ので、この拒否は前の候補が無いことの証拠にならない。code が allowlist のものでも開いたまま。
              // 次に確かめるとき、前の op の receipt も引く。
              holdAsUnknown(record, 'pimlico.rebuild.rejected', error);
            }
            // c2: 最初の送信を bundler が検証で拒否した = この intent の op は mempool に無い (前の候補も無い)。
            // 記録を消したと確かめられたときだけ閉じ、今までどおりの error にする (nonce の予約は残さない・金額を変えた
            // 再試行も通常決済もできる)。確かめられなければ、残った op が後で送られうるので開いたまま。
            if (!discardPimlicoPending(pimlicoStorageKey)) {
              holdAsUnknown(record, 'pimlico.send.rejected-unverified', error);
            }
            if (pendingRef.current?.record.userOpHash === record.userOpHash) {
              pendingRef.current = null;
            }
            throw toUserOperationRejection(error, { signed: built.signed, calls });
          },
        });
      };

      // gas ceiling は両 mode で適用。sponsorship では運営赤字回避、erc20 では
      // 顧客の USDC 出費上限の保護として機能する (どちらも UX 上の安全弁)。
      // ここは送信を始める前の fast の検査。UserOp に実際に入る standard は、準備の中の fee の見積もり
      // (lib/smartAccount の各 builder) が ceilingCheckedStandardFee で検査する (A-5)。
      const assertFastGasCeiling = async () => {
        if (chainId !== undefined) {
          const gasPrice = await pimlicoClient.getUserOperationGasPrice();
          assertGasCeiling(chainId, gasPrice.fast.maxFeePerGas);
        }
      };

      if (retained) {
        const calls = buildTransferCalls(params);
        const callFingerprint = fingerprintTransferCalls(calls);
        const latched = { storageKey: pimlicoStorageKey, record: retained };
        pendingRef.current = latched;
        setUnknownPending(latched);
        if (callFingerprint !== retained.callFingerprint) {
          // 別 payment intent への再署名・broadcast を未解決 UserOp から遮断する。
          // 許可する network action は retained.userOpHash の receipt read だけ。
          throw new PimlicoResponseUnknownError({
            userOpHash: retained.userOpHash,
            callFingerprint: retained.callFingerprint,
            reason: 'call-fingerprint-mismatch',
          });
        }
        if (!hasSendLedger(retained)) {
          // 送信の控えが無い記録 (この欄を足す前の記録・MAv2 の facade で送った記録) は今までどおり。
          return waitForRetainedReceipt(retained);
        }
        // 開いている intent への唯一の入口 = 確かめる。別の nonce の op は作らない。
        const record = retained;
        let state: LedgerProbe;
        try {
          state = await probeLedger(record);
        } catch (error) {
          holdAsUnknown(record, 'pimlico.verify.probe-failed', error);
        }
        if (state.kind === 'included') {
          return settleRetained(record, state.userOpHash, state.receipt);
        }
        if (state.kind !== 'open') {
          // consumed (c5): 候補に receipt は無いが nonce は使われた → 成功にも不成立にもせず、receipt を待つ
          // (引けなければ応答不明のまま)。期限を過ぎていても閉じない (実行された可能性がある)。
          // unverifiable: receipt を待つことしかできない (今までの扱い)。
          return waitForRetainedReceipt(record);
        }
        if (isPendingExpired(record)) {
          // c4: 保存から 7 日を過ぎ、候補のどれにも receipt が無く、EntryPoint の nonce も未使用。7 日前の署名済みの op を
          // 今送ると、その時点で支払いが成立しうるので送り直さず、記録を消したと確かめてから閉じる。保存の期限は署名を
          // 取り消さない (残った op を誰かが送れば後から成立しうる・PR の「限界」)。
          if (!discardPimlicoPending(pimlicoStorageKey)) {
            holdAsUnknown(
              record,
              'pimlico.pending.expired-close-failed',
              new Error('discard-failed'),
            );
          }
          pendingRef.current = null;
          setUnknownPending(null);
          logger.warn('pimlico.pending.expired-closed', {
            userOpHash: record.userOpHash,
            updatedAt: record.updatedAt,
          });
          throw new PimlicoIntentClosedError();
        }
        // まだ取り込まれておらず nonce も使われていない → 保存した署名済みの op を 1 字も変えずに送り直す。
        const { client } = state;
        return broadcastRecorded({
          client,
          record,
          latched: true,
          // bundler がその op を検証で拒否した (paymaster の期限切れ等) → 同じ nonce で作り直す (ウォレットの署名が
          // 1 回要る)。intent は開いたまま (c3)。元の op が先に取り込まれていれば、作り直しは AA25 で落ちる。
          onRejected: () =>
            buildAndSend({
              client,
              calls,
              callFingerprint,
              nonce: ledgerNonce(record.send),
              previous: record,
            }),
        });
      }

      // JPYC ガス無料化 (2026-06-05): JPYC sponsorship のガス代立替回収を全廃したため、
      // 旧「feeReceiver 集約額 > 0 必須」の濫用防御ガードは撤去 (OpenPay が JPYC gas を
      // 全額負担する設計に変更)。paymaster の濫用対策は Pimlico policy 制限と relayer/
      // paymaster 低残高監視 (#148) に委ねる。gasReimbursement は呼出側で常に 0。

      await assertFastGasCeiling();

      const calls = buildTransferCalls(params);

      if (signedSend) {
        // nonce (key と seq) を署名の前に決め、署名済みの op と一緒に送信の前に保存する。
        return buildAndSend({
          client: signedSend,
          calls,
          callFingerprint: fingerprintTransferCalls(calls),
          nonce: await reserveUserOpNonce(signedSend),
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

      return waitForRetainedReceipt(pendingRecord);
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
  });

  const retryReceipt = useCallback(() => {
    const retained =
      pendingRef.current?.storageKey === pimlicoStorageKey
        ? pendingRef.current.record
        : null;
    if (!retained || mutation.isPending) return;
    mutation.mutate(deserializeBatchPaymentParams(retained.params));
  }, [mutation, pimlicoStorageKey]);

  // 画面 (フォーム) から最後に送った支払いの内容 (calls の fingerprint)。retryReceipt は保存した intent の params で
  // 送るので、ここには入れない (第 10 回レビュー A-1 の MUST 2: 成功の表示を確定した intent に結び付ける)。
  const [submittedFingerprint, setSubmittedFingerprint] = useState<Hex | null>(
    null,
  );
  const { mutate: rawMutate, mutateAsync: rawMutateAsync } = mutation;
  const mutate = useCallback<typeof rawMutate>(
    (params, options) => {
      setSubmittedFingerprint(attemptFingerprint(params));
      rawMutate(params, options);
    },
    [rawMutate],
  );
  const mutateAsync = useCallback<typeof rawMutateAsync>(
    (params, options) => {
      setSubmittedFingerprint(attemptFingerprint(params));
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
}): Promise<BatchPaymentResult> {
  const { bundle, params, customer, chainId, walletClient, publicClient } = args;
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
    { computeCallHash, stableAttemptId, clearStableAttemptId },
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

  // 冪等試行 ID:
  //   - 明示供給 (params.paymentAttemptId) があればそれを素通しし、マッピングは一切触らない。
  //   - 無ければ callHash 由来の安定マッピング (sessionStorage) で同一タブの再クリック/reload に
  //     同じ attemptId を割り当て、executeCirclePayment 内の crash-resume 分岐を機能させる。
  // sender は executeCirclePayment が computeIdempotencyKey に使う owner (=customer) と同一値、
  // chainId は executeCirclePayment が使う bundle.chainId と同一値にする (key 不一致を避ける)。
  const usesStableMapping = params.paymentAttemptId === undefined;
  const attemptArgs = { chainId: bundle.chainId, sender: customer, callHash: computeCallHash(calls) };
  const attemptId = params.paymentAttemptId ?? stableAttemptId(attemptArgs);

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
    });
  } catch (error) {
    // CirclePendingError (broadcast 済・確認待ち) はマッピングを保持し、再クリックで自 attempt を
    // resume させる。それ以外の確定的エラー (revert/拒否/abandon 済) はマッピングを破棄して、
    // resumed 分岐の「この決済試行は既に終了しています」に正規の再試行がぶつからないようにする。
    if (usesStableMapping && (error as Error).name !== 'CirclePendingError') {
      clearStableAttemptId(attemptArgs);
    }
    throw error;
  }
  // 成功確定 → マッピングを破棄 (次の同額購入は新 attempt。直近 double-click の dedup は
  // scan の CONFIRMED_DEDUP_WINDOW_MS が引き続き担う)。
  if (usesStableMapping) clearStableAttemptId(attemptArgs);

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
