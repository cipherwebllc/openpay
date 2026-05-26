// Cross-chain payment 実行 (wagmi 非依存、clients を引数で受ける純粋関数)。
// fail-fast (try/catch なし)、caller (useCrossChainPayment) が error state に
// 倒す。ProgressCallback で各 step を UI に report。
//
// 2026-05-27 (案A′): OpenPay 利用料を cross-chain でも徴収するため、merchant 宛の
// 本送金に加えて feeReceiver 宛にもう 1 本ブリッジする。Gateway はデポジット
// モデル、CCTP は EOA approve モデルだが、いずれも「operator 宛 burn をもう 1 本」
// 出すことで fee を dest チェーン (= merchant のチェーン) に着金させ、通常決済と
// 同じ「利用料は店チェーンに集約」会計に揃える。feeAmount=0 or feeReceiver 未指定
// 時は fee ブリッジを skip し、従来と完全同一の挙動になる (後方互換)。

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

// ========== Gateway path ==========

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
  overrides?: BuildBurnIntentOverrides;
  fetch?: FetchLike;
  attestationBaseUrl?: string;
  onProgress?: ProgressCallback;
}

export interface ExecuteGatewayTransferResult {
  path: 'gateway';
  signature: Hex;
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
  // fee>0 かつ feeReceiver 指定時のみ fee ブリッジを実行する。ローカルに取り出して
  // `if (bridgeFee)` 内で feeReceiver を Address に絞り込めるようにする (aliased
  // type narrowing)。
  const feeReceiver = args.feeReceiver;
  const feeAmount = args.feeAmount ?? 0n;
  const bridgeFee = feeReceiver !== undefined && feeAmount > 0n;

  // 明示的に Chain object を解決する。args.walletClient.chain は wagmi の
  // useWalletClient closure を経由するため switchChainAsync 後に stale な
  // reference のまま (viem が "current chain mismatch" を投げる根本原因)。
  const destChain = resolveChainOrThrow(args.destChainId, 'destination');

  // sign は chainId 不要だが wallet UI に source chain を表示する UX のため switch する。
  onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
  await args.switchChainAsync({ chainId: args.sourceChainId });

  const currentBlockHeight = await args.sourcePublicClient.getBlockNumber();

  // source chain 上で 1 件分の burn intent を sign + attest する closure。
  // merchant 本送金と operator 利用料の両方で再利用する。phase で progress の
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

  // dest chain 上で attestation を mint する closure。
  const mint = async (
    attestation: Hex,
    attestationSignature: Hex,
  ): Promise<Hex> => {
    const data = encodeGatewayMintCalldata(attestation, attestationSignature);
    const hash = await args.walletClient.sendTransaction({
      account: args.account,
      chain: destChain,
      to: GATEWAY_MINTER_ADDRESS,
      data,
    });
    return hash;
  };

  // 1. merchant 本送金の sign + attest
  const merchant = await signAndAttest(args.recipient, args.valueAtomic, 'merchant');

  // 2. fee ブリッジの sign + attest (source chain にいる間に署名まで済ませる)
  let feeAtt: { attestation: Hex; attestationSignature: Hex } | undefined;
  if (bridgeFee) {
    const f = await signAndAttest(feeReceiver, feeAmount, 'fee');
    feeAtt = {
      attestation: f.attestation,
      attestationSignature: f.attestationSignature,
    };
  }

  // 3. dest chain に switch して mint (merchant → fee の順)
  onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
  await args.switchChainAsync({ chainId: args.destChainId });

  const mintHash = await mint(merchant.attestation, merchant.attestationSignature);
  onProgress({ kind: 'dest_tx_pending', hash: mintHash });
  await args.destPublicClient.waitForTransactionReceipt({ hash: mintHash });

  let feeMintTxHash: Hex | undefined;
  if (feeAtt) {
    feeMintTxHash = await mint(feeAtt.attestation, feeAtt.attestationSignature);
    onProgress({ kind: 'fee_dest_tx_pending', hash: feeMintTxHash });
    await args.destPublicClient.waitForTransactionReceipt({ hash: feeMintTxHash });
  }

  return {
    path: 'gateway',
    signature: merchant.signature,
    attestation: merchant.attestation,
    attestationSignature: merchant.attestationSignature,
    mintTxHash: mintHash,
    feeMintTxHash,
    destChainId: args.destChainId,
  };
}

// ========== CCTP V2 path ==========

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
  attestationMessage: Hex;
  attestationSignature: Hex;
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
  // fee>0 かつ feeReceiver 指定時のみ fee burn を追加する (aliased narrowing 用に
  // ローカルへ取り出す)。
  const feeReceiver = args.feeReceiver;
  const feeAmount = args.feeAmount ?? 0n;
  const bridgeFee = feeReceiver !== undefined && feeAmount > 0n;

  // 明示的に Chain object を解決する。args.walletClient.chain は wagmi の
  // useWalletClient closure を経由するため switchChainAsync 後も stale な
  // reference (= UI 起動時の dest chain) のまま、viem の writeContract /
  // sendTransaction が「current chain mismatch」エラーを投げる根本原因。
  // 2026-05-24 incident: Avalanche→OP 経路で approve が dest (OP) chain object で
  // 呼ばれて wallet (Avalanche) と mismatch、payment 全 abort。chainObjectForId で
  // sourceChainId/destChainId から都度解決し、stale closure を回避する。
  const sourceChain = resolveChainOrThrow(args.sourceChainId, 'source');
  const destChain = resolveChainOrThrow(args.destChainId, 'destination');

  onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
  await args.switchChainAsync({ chainId: args.sourceChainId });

  // merchant + fee の両 burn を 1 回の approve でカバーする。
  onProgress({ kind: 'approve' });
  const approveHash = await args.walletClient.writeContract({
    address: args.sourceToken,
    abi: erc20Abi,
    functionName: 'approve',
    args: [CCTP_V2_TOKEN_MESSENGER_ADDRESS, args.valueAtomic + feeAmount],
    chain: sourceChain,
    account: args.account,
  });
  await args.sourcePublicClient.waitForTransactionReceipt({ hash: approveHash });

  // source chain 上で 1 件分の depositForBurn を実行する closure。
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

  // 1. merchant 本送金 burn
  const burnHash = await burn(args.recipient, args.valueAtomic);
  onProgress({ kind: 'source_tx_pending', hash: burnHash });
  await args.sourcePublicClient.waitForTransactionReceipt({ hash: burnHash });

  // 2. fee burn (source chain にいる間にまとめて burn する)
  let feeBurnHash: Hex | undefined;
  if (bridgeFee) {
    feeBurnHash = await burn(feeReceiver, feeAmount);
    onProgress({ kind: 'fee_source_tx_pending', hash: feeBurnHash });
    await args.sourcePublicClient.waitForTransactionReceipt({ hash: feeBurnHash });
  }

  // 3. attestation を burn ごとに取得 (Iris は burn tx hash で照会)
  onProgress({ kind: 'poll_attestation' });
  const merchantIris = await pollIrisAttestation(args.sourceDomain, burnHash, {
    fetch: args.fetch,
    baseUrl: args.irisBaseUrl,
    intervalMs: args.pollOptions?.intervalMs,
    timeoutMs: args.pollOptions?.timeoutMs,
    sleep: args.pollOptions?.sleep,
    now: args.pollOptions?.now,
  });
  const attestationMessage = merchantIris.message as Hex;
  const attestationSignature = merchantIris.attestation as Hex;

  let feeIris: { message: Hex; attestation: Hex } | undefined;
  if (feeBurnHash) {
    const f = await pollIrisAttestation(args.sourceDomain, feeBurnHash, {
      fetch: args.fetch,
      baseUrl: args.irisBaseUrl,
      intervalMs: args.pollOptions?.intervalMs,
      timeoutMs: args.pollOptions?.timeoutMs,
      sleep: args.pollOptions?.sleep,
      now: args.pollOptions?.now,
    });
    feeIris = { message: f.message as Hex, attestation: f.attestation as Hex };
  }

  // 4. dest chain に switch して mint (merchant → fee の順)
  onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
  await args.switchChainAsync({ chainId: args.destChainId });

  const mintData = encodeReceiveMessageCalldata(
    attestationMessage,
    attestationSignature,
  );
  const mintHash = await args.walletClient.sendTransaction({
    account: args.account,
    chain: destChain,
    to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
    data: mintData,
  });
  onProgress({ kind: 'dest_tx_pending', hash: mintHash });
  await args.destPublicClient.waitForTransactionReceipt({ hash: mintHash });

  let feeMintTxHash: Hex | undefined;
  if (feeIris) {
    const feeMintData = encodeReceiveMessageCalldata(
      feeIris.message,
      feeIris.attestation,
    );
    feeMintTxHash = await args.walletClient.sendTransaction({
      account: args.account,
      chain: destChain,
      to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
      data: feeMintData,
    });
    onProgress({ kind: 'fee_dest_tx_pending', hash: feeMintTxHash });
    await args.destPublicClient.waitForTransactionReceipt({ hash: feeMintTxHash });
  }

  return {
    path: 'cctp-v2',
    approveTxHash: approveHash,
    burnTxHash: burnHash,
    attestationMessage,
    attestationSignature,
    mintTxHash: mintHash,
    feeBurnTxHash: feeBurnHash,
    feeMintTxHash,
    destChainId: args.destChainId,
  };
}
