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
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { chainObjectForId } from '../chains';
import {
  CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
  CCTP_V2_TOKEN_MESSENGER_ADDRESS,
  encodeDepositForBurnCalldata,
  encodeReceiveMessageCalldata,
  pollIrisAttestation,
  type BuildDepositForBurnOverrides,
  type PollIrisAttestationOptions,
} from './cctp';
import { GATEWAY_MINTER_ADDRESS } from './config';
import {
  buildBurnIntent,
  encodeGatewayMintCalldata,
  getBurnIntentTypedData,
  requestAttestation,
  type BuildBurnIntentOverrides,
} from './gateway';
import type {
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
  | { kind: 'fee_dest_tx_pending'; hash: Hex };

export type ProgressCallback = (p: CrossChainProgress) => void;

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

// 既に broadcast 済の hash が on-chain で成功確定しているかを非 throw で確認する。
// receipt が未取得 (未 mine / dropped) や revert の場合は false。
async function txAlreadySucceeded(
  client: PublicClient,
  hash: Hex,
): Promise<boolean> {
  const receipt = await client
    .getTransactionReceipt({ hash })
    .catch(() => null);
  return receipt?.status === 'success';
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
  merchantAttestation?: { attestation: Hex; signature: Hex };
  /** OpenPay 利用料 (operator 宛) の attestation */
  feeAttestation?: { attestation: Hex; signature: Hex };
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
  const bridgeFee = feeReceiver !== undefined && feeAmount > 0n;

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
      const f = await signAndAttest(feeReceiver, feeAmount, 'fee');
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

  const mint = (att: { attestation: Hex; signature: Hex }): Promise<Hex> => {
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
  destChainId: number;
}

export async function executeCctpTransfer(
  args: ExecuteCctpTransferArgs,
): Promise<ExecuteCctpTransferResult> {
  const onProgress = args.onProgress ?? (() => {});
  const onStep = args.onStep ?? (() => {});
  const feeReceiver = args.feeReceiver;
  const feeAmount = args.feeAmount ?? 0n;
  const bridgeFee = feeReceiver !== undefined && feeAmount > 0n;

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

  const needMerchantBurn = !state.burnTxHash;
  const needFeeBurn = bridgeFee && !state.feeBurnTxHash;

  // 1. source chain 上で approve + burn (まだ burn していない分だけ)。
  if (needMerchantBurn || needFeeBurn) {
    onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
    await ensureWalletChain(
      args.walletClient,
      args.switchChainAsync,
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
    // 単位で独立 (idempotent でない) なので、ここが二重支払いの唯一の防御線。
    // 再開時は保存済 hash の attestation を poll して mint へ進む。
    if (needMerchantBurn) {
      const burnHash = await burn(args.recipient, args.valueAtomic);
      persist({ burnTxHash: burnHash });
      onProgress({ kind: 'source_tx_pending', hash: burnHash });
      await waitForReceiptOrThrow(args.sourcePublicClient, burnHash, 'cctp burn');
    }
    if (needFeeBurn) {
      const feeBurnHash = await burn(feeReceiver, feeAmount);
      persist({ feeBurnTxHash: feeBurnHash });
      onProgress({ kind: 'fee_source_tx_pending', hash: feeBurnHash });
      await waitForReceiptOrThrow(
        args.sourcePublicClient,
        feeBurnHash,
        'cctp fee burn',
      );
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
  const feeMintLanded = !bridgeFee
    ? true
    : state.feeMintTxHash
      ? await txAlreadySucceeded(args.destPublicClient, state.feeMintTxHash)
      : false;

  let attestationMessage: Hex | undefined;
  let attestationSignature: Hex | undefined;

  if (!merchantMintLanded || !feeMintLanded) {
    onProgress({ kind: 'poll_attestation' });
    // burn hash から attestation を再取得 (Iris は永続なので resume でも取得可能)。
    let merchantIris: { message: Hex; attestation: Hex } | undefined;
    if (!merchantMintLanded) {
      const iris = await pollIrisAttestation(args.sourceDomain, burnHash, {
        fetch: args.fetch,
        baseUrl: args.irisBaseUrl,
        intervalMs: args.pollOptions?.intervalMs,
        timeoutMs: args.pollOptions?.timeoutMs,
        sleep: args.pollOptions?.sleep,
        now: args.pollOptions?.now,
      });
      merchantIris = { message: iris.message as Hex, attestation: iris.attestation as Hex };
      attestationMessage = merchantIris.message;
      attestationSignature = merchantIris.attestation;
    }
    let feeIris: { message: Hex; attestation: Hex } | undefined;
    if (!feeMintLanded && state.feeBurnTxHash) {
      const iris = await pollIrisAttestation(
        args.sourceDomain,
        state.feeBurnTxHash,
        {
          fetch: args.fetch,
          baseUrl: args.irisBaseUrl,
          intervalMs: args.pollOptions?.intervalMs,
          timeoutMs: args.pollOptions?.timeoutMs,
          sleep: args.pollOptions?.sleep,
          now: args.pollOptions?.now,
        },
      );
      feeIris = { message: iris.message as Hex, attestation: iris.attestation as Hex };
    }

    onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
    await ensureWalletChain(
      args.walletClient,
      args.switchChainAsync,
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
    destChainId: args.destChainId,
  };
}
