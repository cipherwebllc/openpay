// Cross-chain payment 実行ロジック — wagmi に依存しない純粋関数化することで:
//   - hook (useCrossChainPayment) からテスタブルに呼べる
//   - 同じ関数を experimental demo / 本線 PaymentForm 両方から再利用
//
// 各 path の execute 関数は ProgressCallback で step ごとの進行状況を返す
// (UI は step 名を表示して buyer に何が起きているか可視化)。
//
// Async/await のみ、try/catch なし — fail-fast で caller (UI) が
// status を 'error' に倒す。

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

// 進行状況コールバック — UI が "transitioning" indicator を出すために使う。
export type CrossChainProgress =
  | { kind: 'sign' }
  | { kind: 'attest' }
  | { kind: 'switch_chain'; targetChainId: number }
  | { kind: 'approve' }
  | { kind: 'source_tx_pending'; hash: Hex }
  | { kind: 'poll_attestation' }
  | { kind: 'dest_tx_pending'; hash: Hex };

export type ProgressCallback = (p: CrossChainProgress) => void;

// 共通の switchChain 関数 signature (wagmi の useSwitchChain の switchChainAsync
// と互換)。test では vi.fn() で渡す。
export type SwitchChainFn = (args: { chainId: number }) => Promise<unknown>;

// ========== Gateway path ==========

export interface ExecuteGatewayTransferArgs {
  walletClient: WalletClient;
  /** source chain (現在 buyer wallet が居る or 切替先) の publicClient */
  sourcePublicClient: PublicClient;
  /** destination chain の publicClient (mint tx を wait するため) */
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
  /** transfer する atomic USDC (6 decimals) */
  valueAtomic: bigint;
  overrides?: BuildBurnIntentOverrides;
  /** attestation API DI (test 用)、production は global fetch */
  fetch?: FetchLike;
  /** attestation API baseUrl 上書き (test 用) */
  attestationBaseUrl?: string;
  /** progress callback (UI 表示) */
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

/**
 * Gateway path 実行:
 *   1. source chain に switch (sign の chainId 整合性のため)
 *   2. burnIntent を build + EIP-712 sign
 *   3. Circle attestation API へ POST → attestation 取得
 *   4. dest chain に switch
 *   5. GatewayMinter.gatewayMint を呼ぶ (mint tx)
 *   6. mint tx receipt を wait
 */
export async function executeGatewayTransfer(
  args: ExecuteGatewayTransferArgs,
): Promise<ExecuteGatewayTransferResult> {
  const onProgress = args.onProgress ?? (() => {});

  // 1. source chain に switch (sign は chainId 不要だが、wallet が現 chain を
  //    表示する UX のため source に揃える)
  onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
  await args.switchChainAsync({ chainId: args.sourceChainId });

  // 2. build + sign
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

  // 3. attestation 取得
  onProgress({ kind: 'attest' });
  const signedReq: SignedBurnIntentRequest = {
    burnIntent: intent,
    signature,
  };
  const attestation = await requestAttestation(signedReq, {
    fetch: args.fetch,
    baseUrl: args.attestationBaseUrl,
  });

  // 4. dest chain に switch
  onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
  await args.switchChainAsync({ chainId: args.destChainId });

  // 5. mint tx 送信
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

  // 6. wait
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
  /** iris baseUrl 上書き (test 用) */
  irisBaseUrl?: string;
  /** poll options (test 用、production は default で OK) */
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

/**
 * CCTP V2 Fast path 実行:
 *   1. source chain に switch
 *   2. USDC.approve(TokenMessengerV2, value)
 *   3. TokenMessengerV2.depositForBurn (Fast Transfer)
 *   4. iris poll で attestation + message 取得 (~8-20 秒)
 *   5. dest chain に switch
 *   6. MessageTransmitterV2.receiveMessage
 *   7. mint tx receipt を wait
 */
export async function executeCctpTransfer(
  args: ExecuteCctpTransferArgs,
): Promise<ExecuteCctpTransferResult> {
  const onProgress = args.onProgress ?? (() => {});

  // 1. source chain に switch
  onProgress({ kind: 'switch_chain', targetChainId: args.sourceChainId });
  await args.switchChainAsync({ chainId: args.sourceChainId });

  // 2. approve USDC for TokenMessengerV2
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

  // 3. depositForBurn
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

  // 4. iris poll
  onProgress({ kind: 'poll_attestation' });
  const irisMsg = await pollIrisAttestation(args.sourceDomain, burnHash, {
    fetch: args.fetch,
    baseUrl: args.irisBaseUrl,
    intervalMs: args.pollOptions?.intervalMs,
    timeoutMs: args.pollOptions?.timeoutMs,
    sleep: args.pollOptions?.sleep,
    now: args.pollOptions?.now,
  });
  // pollIrisAttestation は message + attestation が存在する complete entry のみ返す
  const attestationMessage = irisMsg.message as Hex;
  const attestationSignature = irisMsg.attestation as Hex;

  // 5. dest chain に switch
  onProgress({ kind: 'switch_chain', targetChainId: args.destChainId });
  await args.switchChainAsync({ chainId: args.destChainId });

  // 6. receiveMessage
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

  // 7. wait
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
