// cross-chain 実行 (lib/crossChain/execute.ts の facade から公開) の共有型。runtime import を
// 持たない leaf にして、executeCctp → executeForward → (型) の参照が runtime の循環に
// ならないようにする (R12)。宣言の本文は分割前の execute.ts と同一。

import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import type {
  AcceptedQuote,
  BuildDepositForBurnOverrides,
  PollIrisAttestationOptions,
} from './cctp';
import type { BurnIntentMarker, BurnSlot } from './burnMarker';
import type { CircleDomain, FetchLike } from './types';

export type CrossChainProgress =
  | { kind: 'forward_pending'; burnHash: Hex }
  | { kind: 'sign' }
  | { kind: 'attest' }
  | { kind: 'switch_chain'; targetChainId: number }
  | { kind: 'approve' }
  | { kind: 'source_tx_pending'; hash: Hex }
  | { kind: 'poll_attestation' }
  | { kind: 'dest_tx_pending'; hash: Hex }
  // OpenPay 利用料 (feeReceiver 宛) ブリッジの step。merchant 本送金と区別して
  // UI が「手数料送金中」を出せるようにする。
  | { kind: 'fee_sign' }
  | { kind: 'fee_attest' }
  | { kind: 'fee_source_tx_pending'; hash: Hex }
  | { kind: 'fee_dest_tx_pending'; hash: Hex }
  // A1: 再開時に「前回 burn を broadcast したか」を on-chain で確かめている最中 / 確かめ
  // きれなかった状態。買い手には「送金し直しているのではない」ことを伝える必要がある。
  | { kind: 'burn_probe' }
  | { kind: 'burn_unconfirmed' }
  // D3: 利用料 (fee) 側だけが未確定。merchant 送金は止めずに進むので、本送金の失敗
  // (burn_unconfirmed) とは別の kind にして UI が二次通知として出せるようにする。
  | { kind: 'fee_burn_unconfirmed' };

export type ProgressCallback = (p: CrossChainProgress) => void;

// merchant mint が **確定** した時点で発火するコールバック (fee mint より前)。Gateway / CCTP は
// merchant を fee より先に mint するため、fee mint が失敗しても merchant 着金を会計ログに
// 取りこぼさないよう、このタイミングで呼ぶ。冪等ではなく resume で複数回呼ばれ得るので、
// 呼出側 (会計ログの集計層) が (bridge + chainId + mintTxHash) で dedup する前提。
export type OnMerchantMint = (info: {
  mintTxHash?: Hex;
  transferSpecHash?: Hex;
  /** CCTP の source burn tx (照合用)。Gateway は burn-intent モデルで undefined。 */
  burnTxHash?: Hex;
  forward?: ForwardAccounting;
}) => void;

// wagmi useSwitchChain.switchChainAsync の signature と互換。
export type SwitchChainFn = (args: { chainId: number }) => Promise<unknown>;

export interface CctpResumeState {
  forward?: ForwardResumeState;
  approveTxHash?: Hex;
  /** merchant 本送金 burn 完了 tx (attestation は burn hash から再取得可能) */
  burnTxHash?: Hex;
  /** OpenPay 利用料 burn 完了 tx */
  feeBurnTxHash?: Hex;
  /** merchant mint 完了 tx */
  mintTxHash?: Hex;
  /** fee mint 完了 tx */
  feeMintTxHash?: Hex;
  /** merchant burn の「送るつもり」marker (broadcast 直前に fail-closed で書く)。
   *  hash が残らなかった中断からの再開で、二重 burn を防ぐ唯一の手掛かり。 */
  burnIntent?: BurnIntentMarker;
  /** fee burn の同 marker (merchant と完全対称) */
  feeBurnIntent?: BurnIntentMarker;
  /** D3: fee burn の状態を自動判定できなかった記録。merchant 送金は進めた上で残す
   *  (次回の再開・サポート照合用)。自動再 burn の根拠には**しない** — 再開のたびに
   *  決定表を引き直す。 */
  feeBurnUnresolved?: BurnUnresolvedNote;
}

/** 未確定 burn の記録 (resume state / 実行結果に載せる最小情報)。 */
export interface BurnUnresolvedNote {
  kind: 'wait' | 'manual';
  /** 決定表 (設計 §4) の行番号 */
  row: number;
  reason: string;
  /** 二段確認で再 burn を開けてよい状態か */
  reburnable: boolean;
}

/** burn-intent marker を fail-closed で永続化する契約。書けなければ **throw** すること
 *  (呼出側はこの throw を burn 中止として扱う)。 */
export type CommitBurnIntentFn = (
  marker: BurnIntentMarker,
  slot: BurnSlot,
  metadata?: { forward: ForwardResumeState },
) => void;

export interface ExecuteCctpTransferArgs {
  forward?: { acceptedQuote: AcceptedQuote; allowBurn?: boolean };
  walletClient: WalletClient;
  sourcePublicClient: PublicClient;
  destPublicClient: PublicClient;
  switchChainAsync: SwitchChainFn;
  account: Address;
  sourceChainId: number;
  destChainId: number;
  destDomain: CircleDomain;
  sourceDomain: CircleDomain;
  sourceToken: Address;
  recipient: Address;
  /** merchant 宛に burn する額 (= amount - feeAmount)。 */
  valueAtomic: bigint;
  /** OpenPay 利用料の送り先 (operator)。指定 + feeAmount>0 で fee burn を追加実行。 */
  feeReceiver?: Address;
  /** OpenPay 利用料 (atomic)。dest チェーンで feeReceiver に mint される。 */
  feeAmount?: bigint;
  /** 中断からの再開用 state。完了済 step を skip する。 */
  resume?: CctpResumeState;
  /** step 完了ごとに最新の resume state を report (永続化用)。 */
  onStep?: (state: CctpResumeState) => void;
  overrides?: BuildDepositForBurnOverrides;
  fetch?: FetchLike;
  irisBaseUrl?: string;
  pollOptions?: Pick<
    PollIrisAttestationOptions,
    'intervalMs' | 'timeoutMs' | 'sleep' | 'now'
  >;
  onProgress?: ProgressCallback;
  /** merchant mint 確定時に発火 (fee mint より前)。会計ログ用。詳細は OnMerchantMint。 */
  onMerchantMint?: OnMerchantMint;
  /** burn-intent marker の fail-closed 永続化 (必須)。throw したら burn を broadcast しない。 */
  commitBurnIntent: CommitBurnIntentFn;
  /** 買い手が manual パネルの二段確認を通した場合のみ true。曖昧な状態の再 burn を開ける。 */
  allowManualReburn?: boolean;
  /** 決定表 row 9/12/18 の自動再 burn を許すか。既定は env flag
   *  (NEXT_PUBLIC_CROSS_CHAIN_BURN_AUTORESUME, 既定 OFF)。test 用に上書きできる。 */
  allowAutoReburn?: boolean;
  /** test 用 (default Date.now)。marker の gap 判定に使う。 */
  now?: () => number;
}

export interface ExecuteCctpTransferResult {
  path: 'cctp-v2';
  /** Forward recovery may adopt a burn without a saved approval hash. Never substitute another tx. */
  approveTxHash?: Hex;
  burnTxHash: Hex;
  /** merchant mint で使った attestation。resume で merchant mint 済の場合 undefined。 */
  attestationMessage?: Hex;
  attestationSignature?: Hex;
  mintTxHash: Hex;
  /** fee burn を行った場合の source burn / dest mint tx hash。 */
  feeBurnTxHash?: Hex;
  feeMintTxHash?: Hex;
  /** D3: merchant 送金は完了したが、利用料 (fee) 側の burn 状態を確定できなかった場合の
   *  記録。UI は成功パネルの二次通知として出す (決済自体は成立している)。 */
  feeBurnUnresolved?: BurnUnresolvedNote;
  destChainId: number;
}

export interface ForwardAccounting {
  grossAtomic: string;
  maxFeeAtomic: string;
  verifiedNetAtomic: string;
  feeCollectedAtomic: string;
}
export interface ForwardResumeState {
  acceptedQuote: AcceptedQuote;
  state: 'intent' | 'broadcast' | 'source-confirmed' | 'awaiting-forward' | 'forward-observed' | 'verified';
  nonce?: Hex;
  eventNonce?: string;
  scanFromBlock: string;
  sourceEvidence?: { txHash: Hex; logIndex: number; blockNumber: string; blockHash: Hex };
  sourceUnresolved?: boolean;
  candidateHash?: Hex;
  forwardState?: string;
  delayReason?: string;
  accounting?: ForwardAccounting;
}
