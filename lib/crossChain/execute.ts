// Cross-chain payment 実行 (wagmi 非依存、clients を引数で受ける純粋関数)。
// fail-fast (try/catch なし)、caller (useCrossChainPayment) が error state に
// 倒す。ProgressCallback で各 step を UI に report。

import {
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
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
  | { kind: 'dest_tx_pending'; hash: Hex };

export type ProgressCallback = (p: CrossChainProgress) => void;

// wagmi useSwitchChain.switchChainAsync の signature と互換。
export type SwitchChainFn = (args: { chainId: number }) => Promise<unknown>;

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
  valueAtomic: bigint;
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
  destChainId: number;
}

export async function executeGatewayTransfer(
  args: ExecuteGatewayTransferArgs,
): Promise<ExecuteGatewayTransferResult> {
  const onProgress = args.onProgress ?? (() => {});

  // sign は chainId 不要だが wallet UI に source chain を表示する UX のため switch する。
  onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
  await args.switchChainAsync({ chainId: args.sourceChainId });

  onProgress({ kind: 'sign' });
  const currentBlockHeight = await args.sourcePublicClient.getBlockNumber();
  const intent = buildBurnIntent({
    sourceDomain: args.sourceDomain,
    destinationDomain: args.destDomain,
    sourceToken: args.sourceToken,
    destinationToken: args.destToken,
    depositor: args.account,
    recipient: args.recipient,
    value: args.valueAtomic,
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

  onProgress({ kind: 'attest' });
  const signedReq: SignedBurnIntentRequest = { burnIntent: intent, signature };
  const attestation = await requestAttestation(signedReq, {
    fetch: args.fetch,
    baseUrl: args.attestationBaseUrl,
  });

  onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
  await args.switchChainAsync({ chainId: args.destChainId });

  const data = encodeGatewayMintCalldata(
    attestation.attestation,
    attestation.signature,
  );
  const mintHash = await args.walletClient.sendTransaction({
    account: args.account,
    chain: args.walletClient.chain,
    to: GATEWAY_MINTER_ADDRESS,
    data,
  });

  onProgress({ kind: 'dest_tx_pending', hash: mintHash });
  await args.destPublicClient.waitForTransactionReceipt({ hash: mintHash });

  return {
    path: 'gateway',
    signature,
    attestation: attestation.attestation,
    attestationSignature: attestation.signature,
    mintTxHash: mintHash,
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
  valueAtomic: bigint;
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
  destChainId: number;
}

export async function executeCctpTransfer(
  args: ExecuteCctpTransferArgs,
): Promise<ExecuteCctpTransferResult> {
  const onProgress = args.onProgress ?? (() => {});

  onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
  await args.switchChainAsync({ chainId: args.sourceChainId });

  onProgress({ kind: 'approve' });
  const approveHash = await args.walletClient.writeContract({
    address: args.sourceToken,
    abi: erc20Abi,
    functionName: 'approve',
    args: [CCTP_V2_TOKEN_MESSENGER_ADDRESS, args.valueAtomic],
    chain: args.walletClient.chain,
    account: args.account,
  });
  await args.sourcePublicClient.waitForTransactionReceipt({ hash: approveHash });

  const burnData = encodeDepositForBurnCalldata({
    value: args.valueAtomic,
    destinationDomain: args.destDomain,
    recipient: args.recipient,
    burnToken: args.sourceToken,
    overrides: args.overrides,
  });
  const burnHash = await args.walletClient.sendTransaction({
    account: args.account,
    chain: args.walletClient.chain,
    to: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    data: burnData,
  });
  onProgress({ kind: 'source_tx_pending', hash: burnHash });
  await args.sourcePublicClient.waitForTransactionReceipt({ hash: burnHash });

  onProgress({ kind: 'poll_attestation' });
  const irisMsg = await pollIrisAttestation(args.sourceDomain, burnHash, {
    fetch: args.fetch,
    baseUrl: args.irisBaseUrl,
    intervalMs: args.pollOptions?.intervalMs,
    timeoutMs: args.pollOptions?.timeoutMs,
    sleep: args.pollOptions?.sleep,
    now: args.pollOptions?.now,
  });
  // pollIrisAttestation は message/attestation が揃った complete entry のみ返す。
  const attestationMessage = irisMsg.message as Hex;
  const attestationSignature = irisMsg.attestation as Hex;

  onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
  await args.switchChainAsync({ chainId: args.destChainId });

  const mintData = encodeReceiveMessageCalldata(
    attestationMessage,
    attestationSignature,
  );
  const mintHash = await args.walletClient.sendTransaction({
    account: args.account,
    chain: args.walletClient.chain,
    to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
    data: mintData,
  });

  onProgress({ kind: 'dest_tx_pending', hash: mintHash });
  await args.destPublicClient.waitForTransactionReceipt({ hash: mintHash });

  return {
    path: 'cctp-v2',
    approveTxHash: approveHash,
    burnTxHash: burnHash,
    attestationMessage,
    attestationSignature,
    mintTxHash: mintHash,
    destChainId: args.destChainId,
  };
}
