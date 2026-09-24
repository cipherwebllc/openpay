// Cross-chain payment 実行 (wagmi 非依存、clients を引数で受ける純粋関数)。
// fail-fast (try/catch なし)、caller (useCrossChainPayment) が error state に
// 倒す。ProgressCallback で各 step を UI に report。
//
// OpenPay 利用料 (案A′): merchant 宛の本送金に加えて feeReceiver 宛にもう 1 本
// ブリッジし、fee を dest チェーン (= merchant のチェーン) に着金させて通常決済と同じ
// 「利用料は店チェーンに集約」会計に揃える。feeAmount=0 or feeReceiver 未指定時は
// fee ブリッジを skip し従来と完全同一の挙動になる (後方互換)。
//
// 中断再開 (resume): 完了済みステップを resume state で skip して
// 「送り出しの二重実行 (= 二重支払い)」を防ぎつつ残りの step だけ再実行する。onStep で
// 各 step 完了を逐次 report し、caller (hook) が localStorage 等へ永続化する。順序は
// merchant 先 → fee 後 (放棄時も merchant への入金が先に確定し顧客が不利にならない)。
// Gateway は finalized の消費/期限証拠で再開する。通常再開は再署名しない。新規経路は既定 OFF。
//
// R12: 実装は protocol 別 module に分けた。この file は公開 API の facade で、export は分割前と
// 同じ (hook・component・test はこの path から import / vi.mock する)。分割先同士の呼び出しは
// この facade を経由しない。
//   executeTypes   … 共有型 (runtime import なしの leaf)
//   executeErrors  … 専用 error class (ここで 1 回だけ定義)
//   executeShared  … wallet chain 切替・receipt 検証・会計 callback の隔離・fee 宛先ガード
//   burnRecovery   … burn 再開安全化 (readBurnReceiptState / resolveBurnSlot / assertBurnResolved / settleBurn)
//   executeGateway … Circle Gateway 経路
//   executeCctp    … CCTP V2 self-mint 経路 (Arc 宛ては executeForward へ)
//   executeForward … CCTP Forwarding Service (Arc 宛て) 経路

export { GatewayRecoveryError, type GatewayResumeState } from './gatewayRecovery';
export type {
  BurnUnresolvedNote,
  CctpResumeState,
  CommitBurnIntentFn,
  CrossChainProgress,
  ExecuteCctpTransferArgs,
  ExecuteCctpTransferResult,
  ForwardAccounting,
  ForwardResumeState,
  OnMerchantMint,
  ProgressCallback,
  SwitchChainFn,
} from './executeTypes';
export {
  CrossChainBurnUnresolvedError,
  CrossChainForwardPendingError,
  CrossChainQuoteExpiredError,
} from './executeErrors';
export { ensureWalletChain } from './executeShared';
export {
  assertGatewayTransferEnabled,
  executeGatewayTransfer,
  type ExecuteGatewayTransferArgs,
  type ExecuteGatewayTransferResult,
} from './executeGateway';
export { executeCctpTransfer } from './executeCctp';
export { assertForwardQuoteBinding } from './executeForward';
