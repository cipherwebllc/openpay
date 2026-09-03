// Cross-chain payment 実行 (wagmi 非依存、clients を引数で受ける純粋関数)。
// fail-fast (try/catch なし)、caller (useCrossChainPayment) が error state に
// 倒す。ProgressCallback で各 step を UI に report。
//
// OpenPay 利用料 (案A′): merchant 宛の本送金に加えて feeReceiver 宛にもう 1 本
// ブリッジし、fee を dest チェーン (= merchant のチェーン) に着金させて通常決済と同じ
// 「利用料は店チェーンに集約」会計に揃える。feeAmount=0 or feeReceiver 未指定時は
// fee ブリッジを skip し従来と完全同一の挙動になる (後方互換)。
//
// 中断再開 (resume): CCTP/Gateway の attestation は永久に有効 (一度 burn すれば
// 後でいつでも mint 可能) なので、完了済みステップを resume state で skip して
// 「送り出しの二重実行 (= 二重支払い)」を防ぎつつ残りの step だけ再実行する。onStep で
// 各 step 完了を逐次 report し、caller (hook) が localStorage 等へ永続化する。順序は
// merchant 先 → fee 後 (放棄時も merchant への入金が先に確定し顧客が不利にならない)。

import {
  erc20Abi,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { chainObjectForId } from '../chains';
import { logger } from '../logger';
import {
  CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
  CCTP_V2_TOKEN_MESSENGER_ADDRESS,
  encodeDepositForBurnCalldata,
  encodeReceiveMessageCalldata,
  pollIrisAttestation,
  type BuildDepositForBurnOverrides,
  type PollIrisAttestationOptions,
} from './cctp';
import {
  buildBurnMarker,
  classifyBurnState,
  minGapBlocks,
  scanForBurnLog,
  MIN_GAP_MS,
  type BurnDecision,
  type BurnIntentMarker,
  type BurnReceiptState,
  type BurnScanResult,
  type BurnSlot,
} from './burnMarker';
import {
  CROSS_CHAIN_BURN_AUTORESUME,
  GATEWAY_MINTER_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
} from './config';
import { assertContractDeployed } from './deploycheck';
import {
  buildBurnIntent,
  encodeGatewayMintCalldata,
  getBurnIntentTypedData,
  requestAttestation,
  type BuildBurnIntentOverrides,
} from './gateway';
import type {
  AttestationResponse,
  CircleDomain,
  FetchLike,
  SignedBurnIntentRequest,
} from './types';

export type CrossChainProgress =
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
  mintTxHash: Hex;
  /** CCTP の source burn tx (照合用)。Gateway は burn-intent モデルで undefined。 */
  burnTxHash?: Hex;
}) => void;

// onMerchantMint を隔離して呼ぶ。会計ログ (best-effort) の例外で、確定済の merchant mint
// 後の決済 flow を中断させないため (callee は通常 void logPaymentEvent で fire-and-forget だが、
// 契約として呼出側でも throw を握り潰す)。
function fireMerchantMint(
  cb: OnMerchantMint | undefined,
  info: { mintTxHash: Hex; burnTxHash?: Hex },
): void {
  if (!cb) return;
  try {
    cb(info);
  } catch {
    /* audit ログ失敗は決済確定に影響させない */
  }
}

// wagmi useSwitchChain.switchChainAsync の signature と互換。
export type SwitchChainFn = (args: { chainId: number }) => Promise<unknown>;

// switchChainAsync は wallet (MetaMask 等) が wallet_switchEthereumChain を resolve
// した時点で返るが、injected provider の eth_chainId が新 chain を報告するまでに
// 僅かな lag があることがある。viem の writeContract / sendTransaction は送信前に
// live eth_chainId を取得して current chain を assert するため、lag 中に tx を出すと
// "current chain of the wallet does not match the target chain" で abort する
// (testnet 実機: Base Sepolia 受取 → OP Sepolia 支払元の approve で再現)。
// switch 後に live chainId が target に揃うまで bounded poll してから戻すことで
// このレースを閉じる。既に target chain なら switch 自体を skip し不要な wallet
// popup を避ける (chainId は live eth_chainId なので stale walletClient closure でも
// 正しく判定できる)。
const CHAIN_SWITCH_CONFIRM_ATTEMPTS = 20;
const CHAIN_SWITCH_CONFIRM_INTERVAL_MS = 150;

export async function ensureWalletChain(
  walletClient: WalletClient,
  switchChainAsync: SwitchChainFn,
  targetChainId: number,
): Promise<void> {
  if ((await walletClient.getChainId()) === targetChainId) return;
  await switchChainAsync({ chainId: targetChainId });
  for (let attempt = 0; attempt < CHAIN_SWITCH_CONFIRM_ATTEMPTS; attempt += 1) {
    if ((await walletClient.getChainId()) === targetChainId) return;
    // 最終 attempt の後は sleep せず即 throw する (switch がこの sleep 中に landed
    // しても再 check されず誤って abort するのを防ぐ — 最後の判定は常に getChainId)。
    if (attempt < CHAIN_SWITCH_CONFIRM_ATTEMPTS - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, CHAIN_SWITCH_CONFIRM_INTERVAL_MS),
      );
    }
  }
  throw new Error(
    `cross-chain execute: wallet chain を ${targetChainId} に切り替え後も ` +
      `eth_chainId が一致しません (wallet が switch を完了していない可能性)`,
  );
}

// chainId → viem Chain object 解決。supportedChains 外なら明示的に throw して
// 「unknown chain で wallet に送ろうとして wallet が NETWORK_UNRECOGNIZED 系の
// 不可解な error を返す」事態を防ぐ。caller (useCrossChainPayment) は
// CROSS_CHAIN_TARGETS / pathEnumerator 経由で chainId を受け取るので
// 実運用では throw に到達しない (= defensive)。
function resolveChainOrThrow(
  chainId: number,
  role: 'source' | 'destination',
): Chain {
  const chain = chainObjectForId(chainId);
  if (!chain) {
    throw new Error(
      `cross-chain execute: ${role} chainId ${chainId} is not in supportedChains ` +
        `(lib/chains.ts に viem Chain を登録するか CROSS_CHAIN_TARGETS から外す)`,
    );
  }
  return chain;
}

// tx receipt を待ち、status が 'success' でなければ throw する。
// viem の waitForTransactionReceipt は tx が revert しても throw せず
// status:'reverted' の receipt を返すだけなので、明示的に検証しないと revert を
// 「成功」として扱い、未着金の決済を完了記録してしまう。
async function waitForReceiptOrThrow(
  client: PublicClient,
  hash: Hex,
  label: string,
): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(
      `cross-chain execute: ${label} tx が revert しました (status=${receipt.status}, ${hash})`,
    );
  }
}

// 既に broadcast 済の hash が on-chain で成功確定しているかを確認する。「未発見」
// (TransactionReceiptNotFoundError = 未 mine / dropped) のみ false。それ以外の reject
// (RPC ダウン / timeout / 5xx) は transport 障害で「未着」と区別できず、false に潰すと
// landed 済 mint の再 broadcast (既消費 attestation で必ず revert・失敗表示) を誘発する
// ため throw で伝播し、resume 再試行に倒す (CR-2 と同じ区別)。
// status==='reverted' は従来どおり false (revert した mint は attestation 未消費なので
// 再 broadcast が正しい)。
async function txAlreadySucceeded(
  client: PublicClient,
  hash: Hex,
): Promise<boolean> {
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return receipt.status === 'success';
  } catch (e) {
    if ((e as { name?: unknown })?.name === 'TransactionReceiptNotFoundError') return false;
    throw e;
  }
}

// 設定ミス (zero / dEaD placeholder) の feeReceiver へブリッジすると利用料分の USDC が
// 永久に焼失する。該当時は fee ブリッジ自体をスキップ (顧客が fee 分を保持する安全側)
// して warn (billing 側の feeReceiverConfigured ガードと同等の防御)。
const FEE_RECEIVER_BURN_ADDRESSES: ReadonlySet<string> = new Set([
  zeroAddress,
  '0x000000000000000000000000000000000000dead',
]);

function isFeeReceiverBridgeable(
  feeReceiver: Address | undefined,
  feeAmount: bigint,
): boolean {
  if (feeReceiver === undefined || feeAmount <= 0n) return false;
  if (FEE_RECEIVER_BURN_ADDRESSES.has(feeReceiver.toLowerCase())) {
    logger.warn('cross-chain.fee.burn-address-receiver', { feeReceiver });
    return false;
  }
  return true;
}

// dest チェーンの mint を「再開安全」に実行する。既に broadcast 済の hash があれば
// on-chain 確定を検証し、成功済なら skip (再 mint は attestation 既消費で必ず
// revert するため)。未確定なら (再)送信し、broadcast 直後に hash を永続化してから
// receipt を待つ — receipt 待ち中に中断しても「landed したのに記録されず resume で
// 必ず revert」する stuck を防ぐ。
async function settleMint(args: {
  client: PublicClient;
  existingHash: Hex | undefined;
  broadcast: () => Promise<Hex>;
  onBroadcast: (hash: Hex) => void;
  label: string;
}): Promise<void> {
  if (
    args.existingHash &&
    (await txAlreadySucceeded(args.client, args.existingHash))
  ) {
    return;
  }
  const hash = await args.broadcast();
  args.onBroadcast(hash);
  await waitForReceiptOrThrow(args.client, hash, args.label);
}

// ========== Gateway path ==========

export interface GatewayResumeState {
  /** merchant 本送金の attestation (取得済なら再 sign せず再利用 = 二重 debit 防止) */
  merchantAttestation?: AttestationResponse;
  /** OpenPay 利用料 (operator 宛) の attestation */
  feeAttestation?: AttestationResponse;
  /** merchant mint 完了 tx */
  mintTxHash?: Hex;
  /** fee mint 完了 tx */
  feeMintTxHash?: Hex;
}

export interface ExecuteGatewayTransferArgs {
  walletClient: WalletClient;
  sourcePublicClient: PublicClient;
  destPublicClient: PublicClient;
  switchChainAsync: SwitchChainFn;
  account: Address;
  sourceChainId: number;
  destChainId: number;
  sourceDomain: CircleDomain;
  destDomain: CircleDomain;
  sourceToken: Address;
  destToken: Address;
  recipient: Address;
  /** merchant 宛にブリッジする額 (= amount - feeAmount)。 */
  valueAtomic: bigint;
  /** OpenPay 利用料の送り先 (operator)。指定 + feeAmount>0 で fee ブリッジ実行。 */
  feeReceiver?: Address;
  /** OpenPay 利用料 (atomic)。dest チェーンで feeReceiver に mint される。 */
  feeAmount?: bigint;
  /** 中断からの再開用 state。完了済 step を skip する。 */
  resume?: GatewayResumeState;
  /** step 完了ごとに最新の resume state を report (永続化用)。 */
  onStep?: (state: GatewayResumeState) => void;
  overrides?: BuildBurnIntentOverrides;
  fetch?: FetchLike;
  attestationBaseUrl?: string;
  onProgress?: ProgressCallback;
  /** merchant mint 確定時に発火 (fee mint より前)。会計ログ用。詳細は OnMerchantMint。 */
  onMerchantMint?: OnMerchantMint;
}

export interface ExecuteGatewayTransferResult {
  path: 'gateway';
  /** merchant burn intent の EIP-712 署名。resume 時は未取得で undefined。 */
  signature?: Hex;
  attestation: Hex;
  attestationSignature: Hex;
  mintTxHash: Hex;
  /** fee ブリッジを行った場合の dest mint tx hash (operator への利用料着金)。 */
  feeMintTxHash?: Hex;
  destChainId: number;
}

export async function executeGatewayTransfer(
  args: ExecuteGatewayTransferArgs,
): Promise<ExecuteGatewayTransferResult> {
  const onProgress = args.onProgress ?? (() => {});
  const onStep = args.onStep ?? (() => {});
  const feeReceiver = args.feeReceiver;
  const feeAmount = args.feeAmount ?? 0n;
  const bridgeFee = isFeeReceiverBridgeable(feeReceiver, feeAmount);

  let state: GatewayResumeState = { ...(args.resume ?? {}) };
  const persist = (patch: Partial<GatewayResumeState>) => {
    state = { ...state, ...patch };
    onStep(state);
  };

  // 明示的に Chain object を解決する。args.walletClient.chain は wagmi の
  // useWalletClient closure を経由するため switchChainAsync 後に stale な
  // reference のまま (viem が "current chain mismatch" を投げる根本原因)。
  const destChain = resolveChainOrThrow(args.destChainId, 'destination');

  const needMerchantAtt = !state.merchantAttestation;
  const needFeeAtt = bridgeFee && !state.feeAttestation;
  let merchantSignature: Hex | undefined;

  // 1. source chain 上で必要な burn intent を sign + attest する。
  if (needMerchantAtt || needFeeAtt) {
    onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
    await ensureWalletChain(
      args.walletClient,
      args.switchChainAsync,
      args.sourceChainId,
    );
    // burn intent は GATEWAY_WALLET に預けた資金に対して発行される。source chain 側の
    // Gateway wallet が実 deploy 済かを署名前に確認する (存在確認のみ・codehash pin しない)。
    await assertContractDeployed(
      args.sourcePublicClient,
      GATEWAY_WALLET_ADDRESS,
      args.sourceChainId,
    );
    const currentBlockHeight = await args.sourcePublicClient.getBlockNumber();

    // 1 件分の burn intent を sign + attest する closure。phase で progress の
    // kind を出し分け、UI が「本送金」と「利用料」を区別できるようにする。
    const signAndAttest = async (
      recipient: Address,
      value: bigint,
      phase: 'merchant' | 'fee',
    ): Promise<{ signature: Hex; attestation: Hex; attestationSignature: Hex }> => {
      onProgress({ kind: phase === 'fee' ? 'fee_sign' : 'sign' });
      const intent = buildBurnIntent({
        sourceDomain: args.sourceDomain,
        destinationDomain: args.destDomain,
        sourceToken: args.sourceToken,
        destinationToken: args.destToken,
        depositor: args.account,
        recipient,
        value,
        currentBlockHeight,
        overrides: args.overrides,
      });
      const typedData = getBurnIntentTypedData(intent);
      const signature = (await args.walletClient.signTypedData({
        account: args.account,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      })) as Hex;
      onProgress({ kind: phase === 'fee' ? 'fee_attest' : 'attest' });
      const signedReq: SignedBurnIntentRequest = { burnIntent: intent, signature };
      const att = await requestAttestation(signedReq, {
        fetch: args.fetch,
        baseUrl: args.attestationBaseUrl,
      });
      return {
        signature,
        attestation: att.attestation,
        attestationSignature: att.signature,
      };
    };

    if (needMerchantAtt) {
      const m = await signAndAttest(args.recipient, args.valueAtomic, 'merchant');
      merchantSignature = m.signature;
      persist({
        merchantAttestation: {
          attestation: m.attestation,
          signature: m.attestationSignature,
        },
      });
    }
    if (needFeeAtt) {
      // needFeeAtt → bridgeFee=true → isFeeReceiverBridgeable が feeReceiver!==undefined を保証
      const f = await signAndAttest(feeReceiver!, feeAmount, 'fee');
      persist({
        feeAttestation: {
          attestation: f.attestation,
          signature: f.attestationSignature,
        },
      });
    }
  }

  const merchantAtt = state.merchantAttestation;
  if (!merchantAtt) {
    throw new Error(
      'executeGatewayTransfer: merchant attestation missing (resume state 不整合)',
    );
  }

  // 2. dest chain に switch して mint (merchant → fee の順)。settleMint が broadcast
  //    済 hash の landed を検証し、成功済なら skip / 未確定なら (再)送信する。switch は
  //    idempotent (同 chain は no-op)。
  onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
  await ensureWalletChain(
    args.walletClient,
    args.switchChainAsync,
    args.destChainId,
  );
  // mint 送信先 (dest chain の Gateway minter) が実 deploy 済かを送信前に確認する。
  await assertContractDeployed(
    args.destPublicClient,
    GATEWAY_MINTER_ADDRESS,
    args.destChainId,
  );

  const mint = (att: AttestationResponse): Promise<Hex> => {
    const data = encodeGatewayMintCalldata(att.attestation, att.signature);
    return args.walletClient.sendTransaction({
      account: args.account,
      chain: destChain,
      to: GATEWAY_MINTER_ADDRESS,
      data,
    });
  };

  await settleMint({
    client: args.destPublicClient,
    existingHash: state.mintTxHash,
    broadcast: () => mint(merchantAtt),
    onBroadcast: (hash) => {
      persist({ mintTxHash: hash });
      onProgress({ kind: 'dest_tx_pending', hash });
    },
    label: 'gateway mint',
  });
  // merchant mint 確定 → 会計ログ発火 (fee mint より前)。settleMint は resume / fresh /
  // 確認待ちを内部で吸収するので、ここに来た時点で merchant 着金は確定している。
  if (state.mintTxHash) {
    fireMerchantMint(args.onMerchantMint, { mintTxHash: state.mintTxHash });
  }
  if (bridgeFee && state.feeAttestation) {
    await settleMint({
      client: args.destPublicClient,
      existingHash: state.feeMintTxHash,
      broadcast: () => mint(state.feeAttestation!),
      onBroadcast: (hash) => {
        persist({ feeMintTxHash: hash });
        onProgress({ kind: 'fee_dest_tx_pending', hash });
      },
      label: 'gateway fee mint',
    });
  }

  if (!state.mintTxHash) {
    throw new Error('executeGatewayTransfer: merchant mint 未完了 (内部不整合)');
  }

  return {
    path: 'gateway',
    signature: merchantSignature,
    attestation: merchantAtt.attestation,
    attestationSignature: merchantAtt.signature,
    mintTxHash: state.mintTxHash,
    feeMintTxHash: state.feeMintTxHash,
    destChainId: args.destChainId,
  };
}

// ========== CCTP V2 path ==========

export interface CctpResumeState {
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

/** 再開時に「前回 burn したか」を自動判定できなかった状態。money-path を進めずここで止め、
 *  UI が買い手に説明する (kind='wait' は時間を置いて再試行、'manual' は explorer 確認 +
 *  二段確認)。Iris timeout 等の他の失敗と UI で区別するために専用型にしている。 */
export class CrossChainBurnUnresolvedError extends Error {
  readonly kind: 'wait' | 'manual';
  readonly slot: BurnSlot;
  readonly detail: string;
  /** 決定表 (設計 §4) の行番号。Sentry で遭遇頻度を行ごとに観測する。 */
  readonly row: number;
  /** 二段確認 (allowManualReburn) で再 burn を開けてよい状態か。 */
  readonly reburnable: boolean;
  readonly sourceChainId: number;
  readonly depositor: Address;
  readonly burnTxHash?: Hex;

  constructor(args: {
    kind: 'wait' | 'manual';
    slot: BurnSlot;
    detail: string;
    row: number;
    reburnable: boolean;
    sourceChainId: number;
    depositor: Address;
    burnTxHash?: Hex;
  }) {
    super(
      `cross-chain execute: ${args.slot} burn の状態を確定できません ` +
        `(${args.kind}, row ${args.row}: ${args.detail})`,
    );
    this.name = 'CrossChainBurnUnresolvedError';
    this.kind = args.kind;
    this.slot = args.slot;
    this.detail = args.detail;
    this.row = args.row;
    this.reburnable = args.reburnable;
    this.sourceChainId = args.sourceChainId;
    this.depositor = args.depositor;
    this.burnTxHash = args.burnTxHash;
  }
}

/** burn-intent marker を fail-closed で永続化する契約。書けなければ **throw** すること
 *  (呼出側はこの throw を burn 中止として扱う)。 */
export type CommitBurnIntentFn = (
  marker: BurnIntentMarker,
  slot: BurnSlot,
) => void;

// hash の receipt 状態を 3 値で読む。TransactionReceiptNotFoundError のみ 'notfound'、
// それ以外の reject (RPC ダウン / timeout) は transport 障害で「未着」と区別できないため
// throw で伝播する (決定表 row 21・txAlreadySucceeded と同じ CR-2 の区別)。
async function readBurnReceiptState(
  client: PublicClient,
  hash: Hex,
): Promise<BurnReceiptState> {
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch (e) {
    if ((e as { name?: unknown })?.name === 'TransactionReceiptNotFoundError') {
      return 'notfound';
    }
    throw e;
  }
}

interface ResolveBurnSlotArgs {
  client: PublicClient;
  slot: BurnSlot;
  marker: BurnIntentMarker | undefined;
  hash: Hex | undefined;
  depositor: Address;
  sourceChainId: number;
  autoReburnEnabled: boolean;
  allowManualReburn: boolean;
  onProgress: ProgressCallback;
  now: () => number;
}

/** 決定表の入力 (nonce / gap / log) を on-chain から集めて classifyBurnState に渡す。
 *  RPC 障害は握り潰さず throw する (「観測できなかった」を「起きていない」に潰すと二重
 *  burn になる)。 */
async function resolveBurnSlot(args: ResolveBurnSlotArgs): Promise<BurnDecision> {
  // 初回 (marker も hash も無い) は probe 不要 — 余計な RPC を打たずに従来どおり burn。
  if (!args.marker && !args.hash) {
    return classifyBurnState({
      marker: undefined,
      hash: undefined,
      receipt: undefined,
      pendingAhead: undefined,
      nonceAdvanced: false,
      gapSatisfied: false,
      timeGapSatisfied: false,
      scan: undefined,
      autoReburnEnabled: args.autoReburnEnabled,
      allowManualReburn: args.allowManualReburn,
    });
  }

  args.onProgress({ kind: 'burn_probe' });

  // D7 (受容したコスト): marker 導入前の旧 state (決定表 row 2) も、ここで source chain の
  // receipt を 1 本読む。以前は「hash があれば無条件に mint へ進む」だったので source RPC に
  // 一切依存しなかったが、revert / 置換された burn を掴んだまま Iris を永久 poll する恒久
  // wedge (A1-(ii)) を塞ぐには receipt の確認が要る。source RPC が落ちていると旧 state の
  // 再開も止まる (throw) — 「観測できなかった」を「成功していた」に潰さないための意図的な
  // 可用性コストとして受け入れる。
  const receipt = args.hash
    ? await readBurnReceiptState(args.client, args.hash)
    : undefined;
  // 成功済 hash は proceed 一択なので nonce も log も見ない (無駄な RPC を打たない)。
  if (receipt === 'success') {
    return classifyBurnState({
      marker: args.marker,
      hash: args.hash,
      receipt,
      pendingAhead: undefined,
      nonceAdvanced: false,
      gapSatisfied: false,
      timeGapSatisfied: false,
      scan: undefined,
      autoReburnEnabled: args.autoReburnEnabled,
      allowManualReburn: args.allowManualReburn,
    });
  }

  // 旧 state (marker 無し・row 3): 走査範囲が無いので log は見られないが、mempool だけは
  // 実測する。二段確認による再 burn を許すかどうかがこの実測 1 点に懸かっているため
  // (未計測のまま override すると mempool 滞留中の再 burn = 二重支払い・D1)。
  if (!args.marker) {
    const [noncePending, nonceLatest] = await Promise.all([
      args.client.getTransactionCount({
        address: args.depositor,
        blockTag: 'pending',
      }),
      args.client.getTransactionCount({
        address: args.depositor,
        blockTag: 'latest',
      }),
    ]);
    return classifyBurnState({
      marker: undefined,
      hash: args.hash,
      receipt,
      pendingAhead: noncePending > nonceLatest,
      nonceAdvanced: false,
      gapSatisfied: false,
      timeGapSatisfied: false, // marker が無い = 基準時刻が無い
      scan: undefined,
      autoReburnEnabled: args.autoReburnEnabled,
      allowManualReburn: args.allowManualReburn,
    });
  }

  const marker = args.marker;
  const [noncePending, nonceLatest, head] = await Promise.all([
    args.client.getTransactionCount({ address: args.depositor, blockTag: 'pending' }),
    args.client.getTransactionCount({ address: args.depositor, blockTag: 'latest' }),
    args.client.getBlockNumber(),
  ]);
  const pendingAhead = noncePending > nonceLatest;
  const nonceAdvanced =
    marker.nonceLatest !== null && nonceLatest > marker.nonceLatest;
  const markerBlock = marker.block === null ? null : BigInt(marker.block);
  const timeGapSatisfied = args.now() - marker.at >= MIN_GAP_MS;
  const gapSatisfied =
    markerBlock !== null &&
    head - markerBlock >= BigInt(minGapBlocks(marker.chainId)) &&
    timeGapSatisfied;

  // mempool に居るうちは log を走査しても意味がない (まだ mined していない) ので RPC を節約。
  // 走査範囲 (block) / 同定条件 (nonce) を欠く marker (row 4) も走査しない — scan を
  // undefined のままにすることで「走査できなかった」と「走査して 0 件だった」を
  // classifyBurnState 側で区別できる (二段確認を開けてよいかの判断が変わる・D1)。
  let scan: BurnScanResult | undefined;
  if (!pendingAhead && markerBlock !== null && marker.nonceLatest !== null) {
    scan = await scanForBurnLog({
      client: args.client,
      marker,
      head,
      tokenMessenger: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    });
  }

  return classifyBurnState({
    marker,
    hash: args.hash,
    receipt,
    pendingAhead,
    nonceAdvanced,
    gapSatisfied,
    timeGapSatisfied,
    scan,
    autoReburnEnabled: args.autoReburnEnabled,
    allowManualReburn: args.allowManualReburn,
  });
}

// 決定が wait / manual なら money-path を進めず専用 error で止める。
function assertBurnResolved(
  decision: BurnDecision,
  ctx: { slot: BurnSlot; sourceChainId: number; depositor: Address; hash?: Hex },
  onProgress: ProgressCallback,
): void {
  if (decision.action !== 'wait' && decision.action !== 'manual') return;
  onProgress({ kind: 'burn_unconfirmed' });
  logger.warn('cross-chain.burn.unresolved', {
    kind: decision.action,
    slot: ctx.slot,
    row: decision.row,
    reason: decision.reason,
    sourceChainId: ctx.sourceChainId,
  });
  throw new CrossChainBurnUnresolvedError({
    kind: decision.action,
    slot: ctx.slot,
    detail: decision.reason,
    row: decision.row,
    reburnable: decision.action === 'manual' ? decision.reburnable : false,
    sourceChainId: ctx.sourceChainId,
    depositor: ctx.depositor,
    burnTxHash: ctx.hash,
  });
}

/** source chain の burn 1 本を「再開安全」に送り出す (settleMint と対称)。
 *  marker を fail-closed で書いてから broadcast → hash 永続化 → receipt 検証、の順で、
 *  「記録の無い burn」も「burn の無い記録」も作らない。
 *  adopt (走査で一意特定した hash の採用) / proceed (既存 hash が成功済) は送金を伴わない
 *  ので呼出側で persist するだけ — ここには 'burn' decision しか来ない。 */
async function settleBurn(args: {
  client: PublicClient;
  buildMarker: () => Promise<BurnIntentMarker>;
  commit: (marker: BurnIntentMarker) => void;
  broadcast: () => Promise<Hex>;
  onBroadcast: (hash: Hex) => void;
  label: string;
}): Promise<void> {
  const marker = await args.buildMarker();
  // 書けなければ throw され、broadcast には到達しない (= 記録の無い burn を作らない)。
  args.commit(marker);
  const hash = await args.broadcast();
  args.onBroadcast(hash);
  await waitForReceiptOrThrow(args.client, hash, args.label);
}

export interface ExecuteCctpTransferArgs {
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
  approveTxHash: Hex;
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

export async function executeCctpTransfer(
  args: ExecuteCctpTransferArgs,
): Promise<ExecuteCctpTransferResult> {
  const onProgress = args.onProgress ?? (() => {});
  const onStep = args.onStep ?? (() => {});
  const feeReceiver = args.feeReceiver;
  const feeAmount = args.feeAmount ?? 0n;
  const bridgeFee = isFeeReceiverBridgeable(feeReceiver, feeAmount);

  let state: CctpResumeState = { ...(args.resume ?? {}) };
  const persist = (patch: Partial<CctpResumeState>) => {
    state = { ...state, ...patch };
    onStep(state);
  };

  // 明示的に Chain object を解決する。args.walletClient.chain は wagmi の
  // useWalletClient closure を経由するため switchChainAsync 後も stale な
  // reference (= UI 起動時の dest chain) のまま、viem の writeContract /
  // sendTransaction が「current chain mismatch」エラーを投げる根本原因。
  // 2026-05-24 incident: Avalanche→OP 経路で approve が dest (OP) chain object で
  // 呼ばれて wallet (Avalanche) と mismatch、payment 全 abort。chainObjectForId で
  // sourceChainId/destChainId から都度解決し、stale closure を回避する。
  const sourceChain = resolveChainOrThrow(args.sourceChainId, 'source');
  const destChain = resolveChainOrThrow(args.destChainId, 'destination');

  // A1: 「burnTxHash が無い = 未 burn」という素朴な判定を廃し、marker + on-chain の事実
  // (receipt / nonce / DepositForBurn log) で slot ごとに分岐を決める。決定表は
  // burnMarker.classifyBurnState (設計 §4)。判定は送金前なので chain switch より先に行い、
  // wait / manual なら wallet popup を一切出さずに止める。
  const allowAutoReburn = args.allowAutoReburn ?? CROSS_CHAIN_BURN_AUTORESUME;
  const allowManualReburn = args.allowManualReburn === true;
  const nowFn = args.now ?? Date.now;
  const resolveSlot = (slot: BurnSlot): Promise<BurnDecision> =>
    resolveBurnSlot({
      client: args.sourcePublicClient,
      slot,
      marker: slot === 'merchant' ? state.burnIntent : state.feeBurnIntent,
      hash: slot === 'merchant' ? state.burnTxHash : state.feeBurnTxHash,
      depositor: args.account,
      sourceChainId: args.sourceChainId,
      autoReburnEnabled: allowAutoReburn,
      allowManualReburn,
      onProgress,
      now: nowFn,
    });

  const merchantDecision = await resolveSlot('merchant');
  assertBurnResolved(
    merchantDecision,
    {
      slot: 'merchant',
      sourceChainId: args.sourceChainId,
      depositor: args.account,
      hash: state.burnTxHash,
    },
    onProgress,
  );
  // D3: fee slot の未確定は **merchant を人質に取らない**。merchant 側が確定している限り、
  // fee が wait / manual でも merchant の attestation + mint はそのまま進める (掟 13: 付帯
  // 処理の障害を本体に波及させない)。fee は自動で再 burn せず、resume state と結果に
  // 「未確定」を記録して UI が二次通知を出す (人間が後で解決する)。
  const feeDecision = bridgeFee ? await resolveSlot('fee') : undefined;
  const feeUnresolved: BurnUnresolvedNote | undefined =
    feeDecision && (feeDecision.action === 'wait' || feeDecision.action === 'manual')
      ? {
          kind: feeDecision.action,
          row: feeDecision.row,
          reason: feeDecision.reason,
          reburnable:
            feeDecision.action === 'manual' ? feeDecision.reburnable : false,
        }
      : undefined;
  if (feeUnresolved) {
    onProgress({ kind: 'fee_burn_unconfirmed' });
    logger.warn('cross-chain.burn.unresolved', {
      kind: feeUnresolved.kind,
      slot: 'fee',
      row: feeUnresolved.row,
      reason: feeUnresolved.reason,
      sourceChainId: args.sourceChainId,
      blocking: false,
    });
    persist({ feeBurnUnresolved: feeUnresolved });
  }

  const needMerchantBurn = merchantDecision.action === 'burn';
  const needFeeBurn = feeDecision?.action === 'burn';
  // adopt は「走査で見つけた成功済 burn hash を採用する」だけなので wallet も chain switch
  // も要らない。approve/burn block の外で先に永続化しておく。
  if (merchantDecision.action === 'adopt') {
    persist({ burnTxHash: merchantDecision.hash });
    onProgress({ kind: 'source_tx_pending', hash: merchantDecision.hash });
  }
  if (feeDecision?.action === 'adopt') {
    persist({ feeBurnTxHash: feeDecision.hash });
    onProgress({ kind: 'fee_source_tx_pending', hash: feeDecision.hash });
  }

  // 1. source chain 上で approve + burn (まだ burn していない分だけ)。
  if (needMerchantBurn || needFeeBurn) {
    onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
    await ensureWalletChain(
      args.walletClient,
      args.switchChainAsync,
      args.sourceChainId,
    );

    // 顧客が実 USDC を approve する送信先 (source chain の CCTP TokenMessenger) が
    // 実 deploy 済かを approve/burn 前に確認する (存在確認のみ・codehash pin しない)。
    await assertContractDeployed(
      args.sourcePublicClient,
      CCTP_V2_TOKEN_MESSENGER_ADDRESS,
      args.sourceChainId,
    );

    // merchant + fee の両 burn を 1 回の approve でカバーする (再開時は残りの burn
    // 用に再 approve、allowance 上書きは無害)。
    onProgress({ kind: 'approve' });
    const approveHash = await args.walletClient.writeContract({
      address: args.sourceToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [CCTP_V2_TOKEN_MESSENGER_ADDRESS, args.valueAtomic + feeAmount],
      chain: sourceChain,
      account: args.account,
    });
    await waitForReceiptOrThrow(
      args.sourcePublicClient,
      approveHash,
      'cctp approve',
    );
    persist({ approveTxHash: approveHash });

    // 1 件分の depositForBurn を実行する closure。
    const burn = async (recipient: Address, value: bigint): Promise<Hex> => {
      const data = encodeDepositForBurnCalldata({
        value,
        destinationDomain: args.destDomain,
        recipient,
        burnToken: args.sourceToken,
        overrides: args.overrides,
      });
      return args.walletClient.sendTransaction({
        account: args.account,
        chain: sourceChain,
        to: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
        data,
      });
    };

    // burn hash は broadcast 直後 (receipt 待ち前) に永続化する。receipt 待ちの間に
    // tab を閉じる / RPC が落ちると resume state に burn hash が残らず、再開時に
    // 再 burn してしまう = 二重支払いになるため。CCTP の depositForBurn は nonce
    // 単位で独立 (idempotent でない) ので、ここが二重支払いの防御線。
    // A1: hash 永続化の **さらに手前** に marker (送るつもり) を fail-closed で置き、
    // 「broadcast したが hash を書けなかった」窓も塞ぐ。再開時は保存済 hash の
    // attestation を poll して mint へ進む。
    const makeMarker = (recipient: Address, value: bigint) => () =>
      buildBurnMarker({
        client: args.sourcePublicClient,
        chainId: args.sourceChainId,
        depositor: args.account,
        burnToken: args.sourceToken,
        mintRecipient: recipient,
        amount: value,
        destinationDomain: args.destDomain,
        now: nowFn,
      });

    if (needMerchantBurn) {
      await settleBurn({
        client: args.sourcePublicClient,
        buildMarker: makeMarker(args.recipient, args.valueAtomic),
        commit: (marker) => {
          args.commitBurnIntent(marker, 'merchant');
          persist({ burnIntent: marker });
        },
        broadcast: () => burn(args.recipient, args.valueAtomic),
        onBroadcast: (hash) => {
          persist({ burnTxHash: hash });
          onProgress({ kind: 'source_tx_pending', hash });
        },
        label: 'cctp burn',
      });
    }
    if (needFeeBurn) {
      // needFeeBurn → bridgeFee=true → isFeeReceiverBridgeable が feeReceiver!==undefined を保証
      await settleBurn({
        client: args.sourcePublicClient,
        buildMarker: makeMarker(feeReceiver!, feeAmount),
        commit: (marker) => {
          args.commitBurnIntent(marker, 'fee');
          persist({ feeBurnIntent: marker });
        },
        broadcast: () => burn(feeReceiver!, feeAmount),
        onBroadcast: (hash) => {
          persist({ feeBurnTxHash: hash });
          onProgress({ kind: 'fee_source_tx_pending', hash });
        },
        label: 'cctp fee burn',
      });
    }
  }

  const burnHash = state.burnTxHash;
  if (!burnHash) {
    throw new Error(
      'executeCctpTransfer: merchant burn hash missing (resume state 不整合)',
    );
  }

  // 2. attestation を取得して dest で mint。broadcast 済の mint hash があれば landed を
  //    検証し、成功済なら skip (再 mint は message 既消費で revert)。未確定のもののみ
  //    attestation を poll して (再)送信し、broadcast 直後に hash を永続化する
  //    (receipt 待ち中の中断で「landed 済なのに resume で必ず revert」になる stuck 防止)。
  const merchantMintLanded = state.mintTxHash
    ? await txAlreadySucceeded(args.destPublicClient, state.mintTxHash)
    : false;
  // D3: fee slot が未確定の run では fee を「この run の対象外」に倒す (poll も mint も
  // しない)。未確定 = burn したかどうかが判らない状態なので、その hash で Iris を poll すると
  // timeout まで待たされ、merchant の mint が fee に人質を取られる。
  const feeInScope = bridgeFee && feeUnresolved === undefined;
  const feeMintLanded = !feeInScope
    ? true
    : state.feeMintTxHash
      ? await txAlreadySucceeded(args.destPublicClient, state.feeMintTxHash)
      : false;

  let attestationMessage: Hex | undefined;
  let attestationSignature: Hex | undefined;

  // resume で merchant mint が既に landed している場合、この run では再 mint しない
  // (merchantIris は !merchantMintLanded のときだけ取得される)。確定済の merchant 着金を
  // fee mint より前にここで会計ログ発火する (fee mint 失敗でも取りこぼさない・dedup は集計層)。
  if (merchantMintLanded && state.mintTxHash) {
    fireMerchantMint(args.onMerchantMint, {
      mintTxHash: state.mintTxHash,
      burnTxHash: burnHash,
    });
  }

  if (!merchantMintLanded || !feeMintLanded) {
    onProgress({ kind: 'poll_attestation' });
    // burn hash から attestation を再取得 (Iris は永続なので resume でも取得可能)。
    // merchant と fee の poll は Promise.allSettled で並列化する。fee 側は merchant の
    // attestation 可用性に依存しない (逆も同様)。直列だとどちらかが timeout で throw した
    // 際、もう一方の burn 済資金の mint まで巻き添えで放置される (merchant timeout → fee
    // 永久未 mint / fee timeout → merchant 着金まで止まる)。並列化して、取得できた側だけは
    // 確実に mint し、取得できなかった側のエラーは mint 完了後に throw する (landed 分の hash
    // は persist 済なので、次回 resume は失敗側だけを再 poll する)。
    const pollOpts = {
      fetch: args.fetch,
      baseUrl: args.irisBaseUrl,
      intervalMs: args.pollOptions?.intervalMs,
      timeoutMs: args.pollOptions?.timeoutMs,
      sleep: args.pollOptions?.sleep,
      now: args.pollOptions?.now,
    };
    const needMerchantPoll = !merchantMintLanded;
    const needFeePoll = !feeMintLanded && state.feeBurnTxHash !== undefined;

    const merchantPoll = needMerchantPoll
      ? pollIrisAttestation(args.sourceDomain, burnHash, pollOpts)
      : undefined;
    const feePoll = needFeePoll
      ? pollIrisAttestation(args.sourceDomain, state.feeBurnTxHash!, pollOpts)
      : undefined;

    const [merchantSettled, feeSettled] = await Promise.allSettled([
      merchantPoll ?? Promise.resolve(undefined),
      feePoll ?? Promise.resolve(undefined),
    ]);

    let merchantIris: { message: Hex; attestation: Hex } | undefined;
    let feeIris: { message: Hex; attestation: Hex } | undefined;
    // 取得できなかった (rejected) 側のエラー。両方必要だった場合、片方だけ rejected なら
    // 取得できた mint を完了させてから throw する (もう一方の burn 済資金を巻き込まない)。
    let merchantPollError: unknown;
    let feePollError: unknown;

    if (needMerchantPoll) {
      if (merchantSettled.status === 'fulfilled' && merchantSettled.value) {
        merchantIris = {
          message: merchantSettled.value.message as Hex,
          attestation: merchantSettled.value.attestation as Hex,
        };
        attestationMessage = merchantIris.message;
        attestationSignature = merchantIris.attestation;
      } else if (merchantSettled.status === 'rejected') {
        merchantPollError = merchantSettled.reason;
      }
    }
    if (needFeePoll) {
      if (feeSettled.status === 'fulfilled' && feeSettled.value) {
        feeIris = {
          message: feeSettled.value.message as Hex,
          attestation: feeSettled.value.attestation as Hex,
        };
      } else if (feeSettled.status === 'rejected') {
        feePollError = feeSettled.reason;
      }
    }

    // 必要だった poll が両方 reject → どちらの attestation も使えないので chain switch せず
    // 即時 throw する (merchant 側のエラーを優先して伝播)。
    const merchantFailed = needMerchantPoll && merchantIris === undefined;
    const feeFailed = needFeePoll && feeIris === undefined;
    if (merchantFailed && feeFailed) {
      throw merchantPollError ?? feePollError;
    }

    onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
    await ensureWalletChain(
      args.walletClient,
      args.switchChainAsync,
      args.destChainId,
    );
    // receiveMessage (mint) 送信先 (dest chain の CCTP MessageTransmitter) が実 deploy
    // 済かを送信前に確認する。
    await assertContractDeployed(
      args.destPublicClient,
      CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
      args.destChainId,
    );

    if (merchantIris) {
      const mintData = encodeReceiveMessageCalldata(
        merchantIris.message,
        merchantIris.attestation,
      );
      const mintHash = await args.walletClient.sendTransaction({
        account: args.account,
        chain: destChain,
        to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
        data: mintData,
      });
      persist({ mintTxHash: mintHash });
      onProgress({ kind: 'dest_tx_pending', hash: mintHash });
      await waitForReceiptOrThrow(args.destPublicClient, mintHash, 'cctp mint');
      // fresh merchant mint 確定 → 会計ログ発火 (下の fee mint より前)。
      fireMerchantMint(args.onMerchantMint, {
        mintTxHash: mintHash,
        burnTxHash: burnHash,
      });
    }
    if (feeIris) {
      const feeMintData = encodeReceiveMessageCalldata(
        feeIris.message,
        feeIris.attestation,
      );
      const feeMintHash = await args.walletClient.sendTransaction({
        account: args.account,
        chain: destChain,
        to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
        data: feeMintData,
      });
      persist({ feeMintTxHash: feeMintHash });
      onProgress({ kind: 'fee_dest_tx_pending', hash: feeMintHash });
      await waitForReceiptOrThrow(
        args.destPublicClient,
        feeMintHash,
        'cctp fee mint',
      );
    }

    // 片方だけ取得できたケース: 取得できた mint を完了させた後で、取得できなかった側の
    // エラーを throw する。landed 分の hash は persist 済なので、次回 resume は失敗側だけを
    // 再 poll する。末尾の整合性チェック (approve/mint 未完了) より前に throw することで、
    // merchant poll 失敗時に「内部不整合」へ化けさせない。
    if (merchantFailed) throw merchantPollError;
    if (feeFailed) throw feePollError;
  }

  if (!state.approveTxHash || !state.mintTxHash) {
    throw new Error('executeCctpTransfer: approve / mint 未完了 (内部不整合)');
  }

  return {
    path: 'cctp-v2',
    approveTxHash: state.approveTxHash,
    burnTxHash: burnHash,
    attestationMessage,
    attestationSignature,
    mintTxHash: state.mintTxHash,
    feeBurnTxHash: state.feeBurnTxHash,
    feeMintTxHash: state.feeMintTxHash,
    feeBurnUnresolved: feeUnresolved,
    destChainId: args.destChainId,
  };
}
